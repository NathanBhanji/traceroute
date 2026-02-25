// Package traceroute runs the system traceroute binary and streams parsed hops.
//
// On macOS and Linux, /usr/sbin/traceroute (or /usr/bin/traceroute) already
// carries the setuid-root bit set by the OS vendor, so no additional
// privileges are required from the calling process.
// On Windows, the equivalent is C:\Windows\System32\tracert.exe, which also
// runs without elevation.
package traceroute

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// Hop represents a single traceroute hop result.
type Hop struct {
	TTL       int     `json:"ttl"`
	IP        string  `json:"ip"`
	Hostname  string  `json:"hostname"`
	RTT       float64 `json:"rtt"` // milliseconds, median of probes
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

// Run executes the system traceroute binary, parsing its output line-by-line
// and streaming Hop values to the hops channel. The channel is NOT closed by
// this function — the caller is responsible for closing it after Run returns.
func Run(ctx context.Context, dest string, opts *Options, hops chan<- Hop) error {
	if opts == nil {
		opts = DefaultOptions()
	}

	binary, args, err := buildCommand(dest, opts)
	if err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, binary, args...)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("cannot create stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("cannot create stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("cannot start %s: %w", binary, err)
	}

	// Drain stderr (warnings from traceroute, e.g. "multiple addresses")
	go io.Copy(io.Discard, stderr)

	destIP := "" // filled once we parse the header line
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
		if line == "" {
			continue
		}

		// Header line: "traceroute to google.com (142.251.30.138), 30 hops max, 40 byte packets"
		if strings.HasPrefix(line, "traceroute to ") || strings.HasPrefix(strings.TrimSpace(line), "Tracing") {
			destIP = parseDestIP(line)
			continue
		}

		hop, ok := parseLine(line, destIP)
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

// ErrMaxHopsReached is returned when the traceroute exhausts all hops without
// reaching the destination.
var ErrMaxHopsReached = fmt.Errorf("max hops reached")

// buildCommand constructs the platform-appropriate command and arguments.
func buildCommand(dest string, opts *Options) (string, []string, error) {
	timeoutSecs := opts.TimeoutMs / 1000
	if timeoutSecs < 1 {
		timeoutSecs = 1
	}

	switch runtime.GOOS {
	case "darwin":
		// macOS traceroute flags:
		//   -m <maxhops>   max TTL
		//   -w <secs>      per-hop wait
		//   -q 1           send only 1 probe per hop (cleaner output)
		binary := "/usr/sbin/traceroute"
		args := []string{
			"-m", strconv.Itoa(opts.MaxHops),
			"-w", strconv.Itoa(timeoutSecs),
			"-q", "1",
			dest,
		}
		return binary, args, nil

	case "linux":
		// Try traceroute, fall back to tracepath
		binary := "/usr/bin/traceroute"
		if _, err := exec.LookPath(binary); err != nil {
			if alt, err2 := exec.LookPath("traceroute"); err2 == nil {
				binary = alt
			} else {
				return "", nil, fmt.Errorf("traceroute binary not found; install inetutils-traceroute or traceroute")
			}
		}
		args := []string{
			"-m", strconv.Itoa(opts.MaxHops),
			"-w", strconv.Itoa(timeoutSecs),
			"-q", "1",
			dest,
		}
		return binary, args, nil

	case "windows":
		// Windows uses tracert; -h = max hops, -w = timeout in ms
		args := []string{
			"-h", strconv.Itoa(opts.MaxHops),
			"-w", strconv.Itoa(opts.TimeoutMs),
			dest,
		}
		return "tracert", args, nil

	default:
		return "", nil, fmt.Errorf("unsupported platform: %s", runtime.GOOS)
	}
}

// Header line patterns:
// macOS/Linux: "traceroute to google.com (142.251.30.138), 30 hops max, 40 byte packets"
// Windows:     "Tracing route to google.com [142.251.30.138]"
var reDestIP = regexp.MustCompile(`[\(\[](\d+\.\d+\.\d+\.\d+)[\)\]]`)

func parseDestIP(line string) string {
	m := reDestIP.FindStringSubmatch(line)
	if len(m) < 2 {
		return ""
	}
	return m[1]
}

// Hop line patterns (macOS/Linux with -q 1):
//
//	" 1  192.168.1.1 (192.168.1.1)  3.224 ms"
//	" 1  router.local (192.168.1.1)  3.224 ms"
//	" 2  *"
//	" 2  * * *"
//
// Windows:
//
//	"  1    <1 ms    <1 ms    <1 ms  192.168.1.1"
//	"  2     *        *        *     Request timed out."
//
// We handle all variants with a single flexible regex.

// macOS/Linux hop line: TTL, then either timeout or host data.
// Group 1: TTL
// Group 2: hostname (optional)
// Group 3: IP
// Group 4: RTT value (first probe)
var reUnixHop = regexp.MustCompile(`^\s*(\d+)\s+(?:(\S+)\s+\((\d+\.\d+\.\d+\.\d+)\)|(\d+\.\d+\.\d+\.\d+))\s+([\d.]+)\s+ms`)

// macOS/Linux timeout: " N  *" or " N  * * *"
var reUnixTimeout = regexp.MustCompile(`^\s*(\d+)\s+\*`)

// Windows hop: "  N  <1 ms  3 ms  4 ms  192.168.1.1"
var reWinHop = regexp.MustCompile(`^\s*(\d+)\s+(?:<?\d+\s+ms\s+){1,3}\s*(\d+\.\d+\.\d+\.\d+|\S+)`)

// Windows RTT extraction
var reWinRTT = regexp.MustCompile(`(\d+)\s+ms`)

// Windows timeout
var reWinTimeout = regexp.MustCompile(`^\s*(\d+)\s+\*`)

func parseLine(line, destIP string) (Hop, bool) {
	if runtime.GOOS == "windows" {
		return parseWindowsLine(line, destIP)
	}
	return parseUnixLine(line, destIP)
}

func parseUnixLine(line, destIP string) (Hop, bool) {
	// Timeout line
	if m := reUnixTimeout.FindStringSubmatch(line); m != nil {
		// Only emit if it's truly a timeout line (contains * after TTL, no RTT)
		if strings.Contains(line, "*") && !reUnixHop.MatchString(line) {
			ttl, _ := strconv.Atoi(m[1])
			return Hop{TTL: ttl, Success: false, IsTimeout: true}, true
		}
	}

	// Successful hop line
	m := reUnixHop.FindStringSubmatch(line)
	if m == nil {
		return Hop{}, false
	}

	ttl, _ := strconv.Atoi(m[1])
	hostname := m[2]
	ip := m[3]
	rttStr := m[5]

	// When there's no hostname, the IP is in group 4
	if ip == "" {
		ip = m[4]
	}

	rtt, _ := strconv.ParseFloat(rttStr, 64)

	isFinal := (destIP != "" && ip == destIP)

	return Hop{
		TTL:       ttl,
		IP:        ip,
		Hostname:  hostname,
		RTT:       rtt,
		Success:   true,
		IsFinal:   isFinal,
		IsTimeout: false,
	}, true
}

func parseWindowsLine(line, destIP string) (Hop, bool) {
	// Windows timeout: "  N  *        *        *     Request timed out."
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

	// Extract RTTs
	rtts := reWinRTT.FindAllStringSubmatch(line, -1)
	var rtt float64
	if len(rtts) > 0 {
		// Use the first RTT value
		rtt, _ = strconv.ParseFloat(rtts[0][1], 64)
	}

	ip := host
	hostname := ""
	// Windows may show hostname [IP]
	if idx := strings.Index(host, " ["); idx != -1 {
		hostname = host[:idx]
		ip = strings.Trim(host[idx+2:], "]")
	}

	isFinal := (destIP != "" && (ip == destIP || host == destIP))

	return Hop{
		TTL:       ttl,
		IP:        ip,
		Hostname:  hostname,
		RTT:       rtt,
		Success:   true,
		IsFinal:   isFinal,
		IsTimeout: false,
	}, true
}
