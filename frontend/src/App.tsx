import { createSignal, createMemo, onCleanup, Show } from 'solid-js';
import type { Component } from 'solid-js';
import SearchBar from './components/SearchBar';
import HopTable from './components/HopTable';
import HistoryPanel from './components/HistoryPanel';
import type { HopData, HopRecord, TraceRecord } from './types';

declare global {
  interface Window {
    go?: {
      main?: {
        App?: {
          StartTraceroute: (host: string, maxHops: number, timeoutMs: number) => Promise<void>;
          StopTraceroute: () => Promise<void>;
          GetHostSuggestions: () => Promise<string[]>;
          GetHistory: (destination: string, limit: number) => Promise<TraceRecord[]>;
          GetTrace: (id: number) => Promise<HopRecord[]>;
          DeleteTrace: (id: number) => Promise<void>;
        };
      };
    };
    runtime?: {
      EventsOn: (event: string, callback: (...args: unknown[]) => void) => () => void;
      EventsOff: (event: string) => void;
    };
  }
}

type AppState = 'idle' | 'running' | 'done' | 'error' | 'maxhops';

const App: Component = () => {
  // Keyed by TTL so out-of-order parallel arrivals merge correctly
  const [hopMap, setHopMap] = createSignal<Map<number, HopData>>(new Map());
  const hops = createMemo(() =>
    [...hopMap().values()].sort((a, b) => a.ttl - b.ttl)
  );
  const [state, setState] = createSignal<AppState>('idle');
  const [destination, setDestination] = createSignal('');
  const [errorMsg, setErrorMsg] = createSignal('');
  const [maxHopsHit, setMaxHopsHit] = createSignal(0);
  const [showHistory, setShowHistory] = createSignal(false);
  const [showOptions, setShowOptions] = createSignal(false);
  const [maxHops, setMaxHops] = createSignal(30);
  const [timeoutMs, setTimeoutMs] = createSignal(3000);
  const [savedTraceId, setSavedTraceId] = createSignal(0);
  const [pendingHost, setPendingHost] = createSignal('');

  // When a historical trace is loaded, display its hops instead of the live ones
  const [historicalHops, setHistoricalHops] = createSignal<HopData[] | null>(null);
  const [historicalLabel, setHistoricalLabel] = createSignal('');

  // What the table actually shows — live hops, or a historical snapshot
  const displayHops = createMemo(() => historicalHops() ?? hops());

  // Total RTT of the most recent completed live trace (for delta comparison in history panel)
  const currentTotalRtt = createMemo(() => {
    const h = hops();
    const last = [...h].reverse().find((hop) => hop.success);
    return last ? last.rtt : null;
  });

  let offHop: (() => void) | undefined;
  let offDone: (() => void) | undefined;
  let offError: (() => void) | undefined;
  let offMaxHops: (() => void) | undefined;
  let offSaved: (() => void) | undefined;

  const teardownListeners = () => {
    offHop?.(); offDone?.(); offError?.(); offMaxHops?.(); offSaved?.();
    offHop = offDone = offError = offMaxHops = offSaved = undefined;
  };

  onCleanup(teardownListeners);

  const handleStart = async (host: string) => {
    teardownListeners();
    setHopMap(new Map());
    setErrorMsg('');
    setMaxHopsHit(0);
    setHistoricalHops(null);
    setHistoricalLabel('');
    setState('running');
    setDestination(host);

    if (window.runtime) {
      offHop = window.runtime.EventsOn('hop', (data: unknown) => {
        const hop = data as HopData;
        setHopMap((prev) => new Map(prev).set(hop.ttl, hop));
      });
      offDone = window.runtime.EventsOn('traceroute:done', () => {
        setState('done');
        teardownListeners();
      });
      offError = window.runtime.EventsOn('traceroute:error', (msg: unknown) => {
        setErrorMsg(String(msg));
        setState('error');
        teardownListeners();
      });
      offMaxHops = window.runtime.EventsOn('traceroute:maxhops', (n: unknown) => {
        setMaxHopsHit(Number(n));
        setState('maxhops');
        teardownListeners();
      });
      offSaved = window.runtime.EventsOn('traceroute:saved', (id: unknown) => {
        setSavedTraceId(Number(id));
      });
    }

    try {
      await window.go?.main?.App?.StartTraceroute(host, maxHops(), timeoutMs());
    } catch (e) {
      setErrorMsg(String(e));
      setState('error');
    }
  };

  const handleStop = async () => {
    try { await window.go?.main?.App?.StopTraceroute(); } catch (_) {}
    setState('done');
    teardownListeners();
  };

  const handleLoadTrace = (hops: HopRecord[], record: TraceRecord) => {
    // Convert HopRecord → HopData for the table
    const asHopData: HopData[] = hops.map((h) => ({
      ttl: h.ttl,
      ip: h.ip,
      hostname: h.hostname,
      rtt: h.rtt,
      success: h.success,
      isFinal: h.isFinal,
      isTimeout: !h.success,
    }));
    setHistoricalHops(asHopData);
    const time = new Date(record.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    setHistoricalLabel(`Showing trace from ${time}`);
  };

  const clearHistorical = () => {
    setHistoricalHops(null);
    setHistoricalLabel('');
  };

  const isRunning = () => state() === 'running';

  return (
    <div class="flex flex-col h-screen bg-surface select-none">
      {/* Drag region */}
      <div class="h-8 shrink-0" style={{ '-webkit-app-region': 'drag' } as any} />

      {/* Toolbar: [History] [input] [Options] [Trace/Stop] */}
      <div class="px-5 pb-3 shrink-0">
        <div class="flex items-center gap-2">

          {/* History toggle — always enabled; shows all history when no destination is set */}
          <button
            type="button"
            onClick={() => setShowHistory((v) => !v)}
            title={destination() ? `History for ${destination()}` : 'All history'}
            class={`h-11 w-11 flex items-center justify-center rounded-xl border transition-all duration-150 shrink-0
              ${showHistory()
                ? 'bg-accent/5 border-accent/20 text-accent'
                : 'bg-white border-surface-200 text-ink-tertiary hover:border-surface-300 hover:text-ink-secondary'
              }`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
          </button>

          {/* Search input (flex-1) */}
          <SearchBar
            onCommit={handleStart}
            onHostChange={setPendingHost}
            onStop={handleStop}
            isRunning={isRunning()}
          />

          {/* Options toggle */}
          <button
            type="button"
            onClick={() => setShowOptions((v) => !v)}
            title="Options"
            class={`h-11 w-11 flex items-center justify-center rounded-xl border transition-all duration-150 shrink-0
              ${showOptions()
                ? 'bg-accent/5 border-accent/20 text-accent'
                : 'bg-white border-surface-200 text-ink-tertiary hover:border-surface-300 hover:text-ink-secondary'
              }`}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
              <line x1="4" y1="6" x2="20" y2="6"/>
              <line x1="4" y1="12" x2="20" y2="12"/>
              <line x1="4" y1="18" x2="20" y2="18"/>
            </svg>
          </button>

          {/* Trace / Stop — primary action */}
          <Show
            when={isRunning()}
            fallback={
              <button
                type="button"
                disabled={!pendingHost().trim()}
                onClick={() => { const h = pendingHost().trim(); if (h) handleStart(h); }}
                class={`h-11 px-5 rounded-xl text-sm font-medium transition-all duration-150 shrink-0
                  ${pendingHost().trim()
                    ? 'bg-accent text-white hover:bg-accent-hover shadow-sm hover:shadow'
                    : 'bg-surface-200 text-ink-tertiary cursor-not-allowed'
                  }`}
              >
                Trace
              </button>
            }
          >
            <button
              type="button"
              onClick={handleStop}
              class="h-11 px-5 rounded-xl text-sm font-medium bg-danger/8 text-danger hover:bg-danger/12 border border-danger/15 transition-all duration-150 shrink-0"
            >
              Stop
            </button>
          </Show>
        </div>

        {/* Options panel — slides in below toolbar */}
        <Show when={showOptions()}>
          <div class="mt-3 flex items-center gap-5 px-1">
            <label class="flex items-center gap-2.5">
              <span class="text-xs font-medium text-ink-tertiary uppercase tracking-wider">Max hops</span>
              <input
                type="number"
                min="1"
                max="64"
                value={maxHops()}
                onInput={(e) => setMaxHops(parseInt(e.currentTarget.value) || 30)}
                class="w-16 h-7 px-2 rounded-lg border border-surface-200 text-sm font-mono text-center bg-white focus:outline-none focus:border-accent text-ink"
              />
            </label>
            <label class="flex items-center gap-2.5">
              <span class="text-xs font-medium text-ink-tertiary uppercase tracking-wider">Timeout</span>
              <div class="flex items-center gap-1">
                <input
                  type="number"
                  min="500"
                  max="10000"
                  step="500"
                  value={timeoutMs()}
                  onInput={(e) => setTimeoutMs(parseInt(e.currentTarget.value) || 3000)}
                  class="w-20 h-7 px-2 rounded-lg border border-surface-200 text-sm font-mono text-center bg-white focus:outline-none focus:border-accent text-ink"
                />
                <span class="text-xs text-ink-tertiary">ms</span>
              </div>
            </label>
          </div>
        </Show>
      </div>

      {/* Max hops warning */}
      <Show when={state() === 'maxhops'}>
        <div class="mx-5 mb-3 flex items-start gap-3 px-4 py-3 rounded-xl bg-warning/5 border border-warning/20 shrink-0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-warning mt-0.5 shrink-0">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <div>
            <p class="text-sm font-medium text-warning">Destination not reached</p>
            <p class="text-xs text-ink-secondary mt-0.5">
              Stopped after <span class="font-mono font-medium">{maxHopsHit()}</span> hops. The host may be blocking ICMP, or increase max hops in options.
            </p>
          </div>
        </div>
      </Show>

      {/* Error */}
      <Show when={state() === 'error'}>
        <div class="mx-5 mb-3 flex items-start gap-3 px-4 py-3 rounded-xl bg-danger/5 border border-danger/15 shrink-0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-danger mt-0.5 shrink-0">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <div class="min-w-0">
            <p class="text-sm font-medium text-danger">Traceroute failed</p>
            <p class="text-xs text-danger/70 mt-0.5 font-mono break-all">{errorMsg()}</p>
          </div>
        </div>
      </Show>

      {/* Historical trace banner */}
      <Show when={historicalLabel()}>
        <div class="mx-5 mb-3 flex items-center justify-between px-4 py-2 rounded-xl bg-accent/5 border border-accent/15 shrink-0">
          <div class="flex items-center gap-2">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-accent shrink-0">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>
            <span class="text-xs text-accent font-medium">{historicalLabel()}</span>
          </div>
          <button onClick={clearHistorical} class="text-xs text-accent/70 hover:text-accent transition-colors">
            Back to live
          </button>
        </div>
      </Show>

      {/* Hop table — fills remaining space */}
      <HopTable
        hops={displayHops()}
        isRunning={isRunning()}
        destination={destination()}
      />

      {/* History panel — docked to bottom */}
      <Show when={showHistory()}>
        <HistoryPanel
          destination={destination()}
          currentTotalRtt={currentTotalRtt()}
          savedTraceId={savedTraceId()}
          onLoadTrace={handleLoadTrace}
          onClose={() => setShowHistory(false)}
        />
      </Show>
    </div>
  );
};

export default App;
