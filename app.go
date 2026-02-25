package main

import (
	"bufio"
	"context"
	"os"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v2/pkg/runtime"

	"app/db"
	"app/traceroute"
)

// App struct
type App struct {
	ctx    context.Context
	mu     sync.Mutex
	cancel context.CancelFunc
	db     *db.DB
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called at application startup
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
	database, err := db.Open()
	if err != nil {
		runtime.LogErrorf(ctx, "failed to open database: %v", err)
		return
	}
	a.db = database
}

// domReady is called after front-end resources have been loaded
func (a *App) domReady(ctx context.Context) {}

// beforeClose is called when the application is about to quit.
func (a *App) beforeClose(ctx context.Context) (prevent bool) {
	return false
}

// shutdown is called at application termination
func (a *App) shutdown(ctx context.Context) {
	a.stopTraceroute()
	if a.db != nil {
		a.db.Close()
	}
}

// StartTraceroute starts a traceroute to the given host.
// Results are streamed to the frontend via "hop" events.
// Any previous traceroute is cancelled first.
func (a *App) StartTraceroute(host string, maxHops int, timeoutMs int) {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
	}
	ctx, cancel := context.WithCancel(a.ctx)
	a.cancel = cancel
	a.mu.Unlock()

	opts := &traceroute.Options{
		MaxHops:   maxHops,
		TimeoutMs: timeoutMs,
	}

	hopChan := make(chan traceroute.Hop, 64)

	// Collect hops for DB storage while also streaming to frontend
	var collected []traceroute.Hop
	go func() {
		for hop := range hopChan {
			collected = append(collected, hop)
			runtime.EventsEmit(a.ctx, "hop", hop)
		}
		runtime.EventsEmit(a.ctx, "traceroute:done", nil)
	}()

	go func() {
		err := traceroute.Run(ctx, host, opts, hopChan)
		close(hopChan)

		// Save to DB (even partial results are worth keeping)
		if a.db != nil && len(collected) > 0 {
			dbHops := make([]db.HopRecord, len(collected))
			for i, h := range collected {
				dbHops[i] = db.HopRecord{
					TTL:      h.TTL,
					IP:       h.IP,
					Hostname: h.Hostname,
					RTT:      h.RTT,
					Success:  h.Success,
					IsFinal:  h.IsFinal,
				}
			}
			if id, saveErr := a.db.SaveTrace(host, dbHops); saveErr != nil {
				runtime.LogErrorf(a.ctx, "failed to save trace: %v", saveErr)
			} else {
				runtime.EventsEmit(a.ctx, "traceroute:saved", id)
			}
		}

		if err == traceroute.ErrMaxHopsReached {
			runtime.EventsEmit(a.ctx, "traceroute:maxhops", maxHops)
		} else if err != nil {
			runtime.EventsEmit(a.ctx, "traceroute:error", err.Error())
		}
	}()
}

// StopTraceroute cancels the current traceroute.
func (a *App) StopTraceroute() {
	a.stopTraceroute()
}

func (a *App) stopTraceroute() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
}

// GetHistory returns the N most recent trace summaries for a destination.
func (a *App) GetHistory(destination string, limit int) []db.TraceRecord {
	if a.db == nil {
		return nil
	}
	records, err := a.db.ListTraces(destination, limit)
	if err != nil {
		runtime.LogErrorf(a.ctx, "GetHistory: %v", err)
		return nil
	}
	return records
}

// GetTrace returns the hops for a specific trace ID.
func (a *App) GetTrace(id int64) []db.HopRecord {
	if a.db == nil {
		return nil
	}
	hops, err := a.db.GetTrace(id)
	if err != nil {
		runtime.LogErrorf(a.ctx, "GetTrace: %v", err)
		return nil
	}
	return hops
}

// DeleteTrace removes a trace from history.
func (a *App) DeleteTrace(id int64) {
	if a.db == nil {
		return
	}
	if err := a.db.DeleteTrace(id); err != nil {
		runtime.LogErrorf(a.ctx, "DeleteTrace: %v", err)
	}
}

// GetHostSuggestions returns hostnames from /etc/hosts (excluding loopback entries)
func (a *App) GetHostSuggestions() []string {
	seen := map[string]bool{}
	var results []string

	f, err := os.Open("/etc/hosts")
	if err != nil {
		return results
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		ip := fields[0]
		if ip == "127.0.0.1" || ip == "::1" || ip == "255.255.255.255" || ip == "fe80::1%lo0" {
			continue
		}
		for _, name := range fields[1:] {
			if strings.HasPrefix(name, "#") {
				break
			}
			if !seen[name] {
				seen[name] = true
				results = append(results, name)
			}
		}
	}
	return results
}
