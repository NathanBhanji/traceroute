// Package traceroute runs the system traceroute binary and streams parsed hops.
//
// Parallel probing (PingPlotter-style): one traceroute process is launched per
// TTL, all concurrently, each with -f N -m N so it probes exactly that one
// hop and exits.  Results arrive out of order and are forwarded immediately to
// the caller's hops channel.
//
// On macOS and Linux, /usr/sbin/traceroute (or /usr/bin/traceroute) already
// carries the setuid-root bit set by the OS vendor, so no additional
// privileges are required from the calling process.
// On Windows, tracert does not support -f/-m in a useful parallel way, so we
// fall back to the classic sequential approach there.
package traceroute

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// Hop represents a single traceroute hop result.
type Hop struct {
	TTL       int     `json:"ttl"`
	IP        string  `json:"ip"`
	Hostname  string  `json:"hostname"`
	RTT       float64 `json:"rtt"` // milliseconds, first probe
	Success   bool    `json:"success"`
	IsFinal   bool    `json:"isFinal"`
	IsTimeout bool    `json:"isTimeout"`
}

// Options configures a traceroute run.
type Options struct {
	MaxHops   int
	TimeoutMs int
}

// DefaultOptions returns sensible defaults.
func DefaultOptions() *Options {
	return &Options{
		MaxHops:   30,
		TimeoutMs: 3000,
	}
}

// ErrMaxHopsReached is returned when the traceroute exhausts all hops without
// reaching the destination.
var ErrMaxHopsReached = fmt.Errorf("max hops reached")

// Run executes parallel per-TTL traceroute probes on Unix, or a single
// sequential traceroute on Windows.  Hops are sent to the hops channel as
// they arrive; the channel is NOT closed by this function.
func Run(ctx context.Context, dest string, opts *Options, hops chan<- Hop) error {
	if opts == nil {
		opts = DefaultOptions()
	}

	if runtime.GOOS == "windows" {
		return runSequential(ctx, dest, opts, hops)
	}
	return runParallel(ctx, dest, opts, hops)
}

// ── Parallel implementation (macOS / Linux) ──────────────────────────────────

func runParallel(ctx context.Context, dest string, opts *Options, hops chan<- Hop) error {
	binary, err := tracerouteBinary()
	if err != nil {
		return err
	}

	timeoutSecs := opts.TimeoutMs / 1000
	if timeoutSecs < 1 {
		timeoutSecs = 1
	}

	// Resolve all destination IPs so we can detect isFinal across goroutines,
	// even when the DNS round-robins to a different address than traceroute hits.
	destIPs := resolveIPs(dest)
	destIP := resolveIP(dest) // single value for parseUnixLine compat

	// results collects one hop per TTL slot; index 0 = TTL 1.
	results := make([]Hop, opts.MaxHops)
	// gotResult[i] is true once TTL i+1 has a result.
	gotResult := make([]atomic.Bool, opts.MaxHops)

	// emitted is a channel that goroutines write their TTL index into once
	// they have a result, so the collector goroutine can forward in real time.
	emitted := make(chan int, opts.MaxHops)

	var wg sync.WaitGroup

	for ttl := 1; ttl <= opts.MaxHops; ttl++ {
		if ctx.Err() != nil {
			break
		}

		wg.Add(1)
		go func(ttl int) {
			defer wg.Done()
			idx := ttl - 1

			args := []string{
				"-f", strconv.Itoa(ttl),
				"-m", strconv.Itoa(ttl),
				"-q", "1",
				"-w", strconv.Itoa(timeoutSecs),
				"-n", // numeric — we do async rDNS ourselves
				dest,
			}
			cmd := exec.CommandContext(ctx, binary, args...)
			out, _ := cmd.Output()

			var hop Hop
			for _, line := range strings.Split(string(out), "\n") {
				line = strings.TrimSpace(line)
				if line == "" || strings.HasPrefix(line, "traceroute") {
					continue
				}
				if h, ok := parseUnixLine(line, destIP); ok {
					hop = h
					break
				}
			}

			// If we got nothing (context cancelled, binary error) emit a timeout.
			if hop.TTL == 0 {
				hop = Hop{TTL: ttl, Success: false, IsTimeout: true}
			}

			// Async reverse-DNS.
			if hop.Success && hop.Hostname == "" && hop.IP != "" {
				if names, err := net.LookupAddr(hop.IP); err == nil && len(names) > 0 {
					hop.Hostname = strings.TrimSuffix(names[0], ".")
				}
			}

			results[idx] = hop
			gotResult[idx].Store(true)

			select {
			case emitted <- idx:
			case <-ctx.Done():
			}
		}(ttl)
	}

	// Wait for all probes, then stream results in TTL order, stopping at the
	// first hop that reached the destination.
	// We must wait for all because the destination responds to every TTL >=
	// its true hop count with the same source IP — only the lowest such TTL
	// is the real final hop.
	wg.Wait()
	close(emitted)
	// Drain the emitted channel (we don't need it anymore, wg is done).
	for range emitted {
	}

	// Find the lowest TTL that hit any of the destination's IPs — true final hop.
	trueFinalTTL := 0
	for i := 0; i < opts.MaxHops; i++ {
		if !gotResult[i].Load() {
			continue
		}
		h := results[i]
		if h.Success && (h.IsFinal || (len(destIPs) > 0 && destIPs[h.IP])) {
			trueFinalTTL = h.TTL
			break // index order = TTL order, so first match is lowest
		}
	}

	// Correct isFinal flags and stream in TTL order up to trueFinalTTL.
	for i := 0; i < opts.MaxHops; i++ {
		if !gotResult[i].Load() {
			continue
		}
		hop := results[i]
		hop.IsFinal = (trueFinalTTL > 0 && hop.TTL == trueFinalTTL)

		select {
		case hops <- hop:
		case <-ctx.Done():
			return nil
		}

		if hop.IsFinal {
			break
		}
	}

	if ctx.Err() != nil {
		return nil
	}
	if trueFinalTTL == 0 {
		return ErrMaxHopsReached
	}
	return nil
}

// ── Sequential implementation (Windows / fallback) ───────────────────────────

func runSequential(ctx context.Context, dest string, opts *Options, hops chan<- Hop) error {
	timeoutSecs := opts.TimeoutMs / 1000
	if timeoutSecs < 1 {
		timeoutSecs = 1
	}

	var binary string
	var args []string

	switch runtime.GOOS {
	case "windows":
		binary = "tracert"
		args = []string{"-h", strconv.Itoa(opts.MaxHops), "-w", strconv.Itoa(opts.TimeoutMs), dest}
	default:
		b, err := tracerouteBinary()
		if err != nil {
			return err
		}
		binary = b
		args = []string{"-m", strconv.Itoa(opts.MaxHops), "-w", strconv.Itoa(timeoutSecs), "-q", "1", dest}
	}

	cmd := exec.CommandContext(ctx, binary, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}

	destIP := resolveIP(dest)
	reachedDest := false
	lastTTL := 0

	scanner := bufio.NewScanner(stdout)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			_ = cmd.Process.Kill()
			return nil
		default:
		}
		line := scanner.Text()
		if line == "" || strings.HasPrefix(strings.TrimSpace(line), "traceroute") || strings.HasPrefix(strings.TrimSpace(line), "Tracing") {
			continue
		}
		var hop Hop
		var ok bool
		if runtime.GOOS == "windows" {
			hop, ok = parseWindowsLine(line, destIP)
		} else {
			hop, ok = parseUnixLine(line, destIP)
		}
		if !ok {
			continue
		}
		hops <- hop
		if hop.TTL > lastTTL {
			lastTTL = hop.TTL
		}
		if hop.IsFinal {
			reachedDest = true
			break
		}
	}
	_ = cmd.Wait()

	if !reachedDest && lastTTL >= opts.MaxHops {
		return ErrMaxHopsReached
	}
	return nil
}

// ── Helpers ───────────────────────────────────────────────────────────────────

func tracerouteBinary() (string, error) {
	switch runtime.GOOS {
	case "darwin":
		return "/usr/sbin/traceroute", nil
	case "linux":
		for _, p := range []string{"/usr/bin/traceroute", "/usr/sbin/traceroute"} {
			if _, err := exec.LookPath(p); err == nil {
				return p, nil
			}
		}
		if p, err := exec.LookPath("traceroute"); err == nil {
			return p, nil
		}
		return "", fmt.Errorf("traceroute binary not found; install inetutils-traceroute or traceroute")
	default:
		return "", fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
}

// resolveIPs returns all IPv4 addresses for a host as a set.
// If the host is already an IP, returns a set containing just that IP.
func resolveIPs(host string) map[string]bool {
	set := map[string]bool{}
	if ip := net.ParseIP(host); ip != nil {
		set[ip.String()] = true
		return set
	}
	addrs, err := net.LookupHost(host)
	if err != nil {
		return set
	}
	for _, a := range addrs {
		if ip := net.ParseIP(a); ip != nil && ip.To4() != nil {
			set[a] = true
		}
	}
	return set
}

// resolveIP returns the first IPv4 address for display / single-comparison use.
func resolveIP(host string) string {
	set := resolveIPs(host)
	for ip := range set {
		return ip
	}
	return host
}

// ── Line parsers ──────────────────────────────────────────────────────────────

// With -n flag, output is always numeric, so hostname group won't appear.
// Patterns we handle:
//
//	" 1  192.168.1.1  3.224 ms"          (numeric only, -n)
//	" 1  host.example (1.2.3.4)  3 ms"   (with hostname, no -n)
//	" 1  *"
var reUnixHopNumeric = regexp.MustCompile(`^\s*(\d+)\s+(\d+\.\d+\.\d+\.\d+)\s+([\d.]+)\s+ms`)
var reUnixHopNamed = regexp.MustCompile(`^\s*(\d+)\s+(\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)\s+([\d.]+)\s+ms`)
var reUnixTimeout = regexp.MustCompile(`^\s*(\d+)\s+\*`)

func parseUnixLine(line, destIP string) (Hop, bool) {
	// Timeout
	if m := reUnixTimeout.FindStringSubmatch(line); m != nil {
		if strings.Contains(line, "*") && reUnixHopNumeric.FindString(line) == "" && reUnixHopNamed.FindString(line) == "" {
			ttl, _ := strconv.Atoi(m[1])
			return Hop{TTL: ttl, Success: false, IsTimeout: true}, true
		}
	}

	// Numeric-only (with -n)
	if m := reUnixHopNumeric.FindStringSubmatch(line); m != nil {
		ttl, _ := strconv.Atoi(m[1])
		ip := m[2]
		rtt, _ := strconv.ParseFloat(m[3], 64)
		return Hop{
			TTL:     ttl,
			IP:      ip,
			RTT:     rtt,
			Success: true,
			IsFinal: destIP != "" && ip == destIP,
		}, true
	}

	// Named (hostname + IP)
	if m := reUnixHopNamed.FindStringSubmatch(line); m != nil {
		ttl, _ := strconv.Atoi(m[1])
		hostname := m[2]
		ip := m[3]
		rtt, _ := strconv.ParseFloat(m[4], 64)
		return Hop{
			TTL:      ttl,
			IP:       ip,
			Hostname: hostname,
			RTT:      rtt,
			Success:  true,
			IsFinal:  destIP != "" && ip == destIP,
		}, true
	}

	return Hop{}, false
}

var reWinHop = regexp.MustCompile(`^\s*(\d+)\s+(?:<?\d+\s+ms\s+){1,3}\s*(\S+)`)
var reWinRTT = regexp.MustCompile(`(\d+)\s+ms`)
var reWinTimeout = regexp.MustCompile(`^\s*(\d+)\s+\*`)

func parseWindowsLine(line, destIP string) (Hop, bool) {
	if reWinTimeout.MatchString(line) && strings.Contains(line, "*") {
		m := reWinTimeout.FindStringSubmatch(line)
		ttl, _ := strconv.Atoi(m[1])
		return Hop{TTL: ttl, Success: false, IsTimeout: true}, true
	}
	m := reWinHop.FindStringSubmatch(line)
	if m == nil {
		return Hop{}, false
	}
	ttl, _ := strconv.Atoi(m[1])
	host := strings.TrimSpace(m[2])
	rtts := reWinRTT.FindAllStringSubmatch(line, -1)
	var rtt float64
	if len(rtts) > 0 {
		rtt, _ = strconv.ParseFloat(rtts[0][1], 64)
	}
	ip, hostname := host, ""
	if idx := strings.Index(host, " ["); idx != -1 {
		hostname = host[:idx]
		ip = strings.Trim(host[idx+2:], "]")
	}
	return Hop{
		TTL:      ttl,
		IP:       ip,
		Hostname: hostname,
		RTT:      rtt,
		Success:  true,
		IsFinal:  destIP != "" && (ip == destIP || host == destIP),
	}, true
}
