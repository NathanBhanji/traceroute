import { createSignal, createEffect, For, Show } from 'solid-js';
import type { Component } from 'solid-js';
import type { TraceRecord, HopRecord } from '../types';

interface HistoryPanelProps {
  destination: string;          // current destination being viewed
  currentTotalRtt: number | null; // total RTT of the live/latest trace
  onLoadTrace: (hops: HopRecord[], record: TraceRecord) => void;
  onClose: () => void;
  // trigger a refresh when a new trace is saved
  savedTraceId: number;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7)   return `${diffDays}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function rttDeltaLabel(current: number, reference: number | null): { text: string; cls: string } | null {
  if (reference === null || reference === 0 || current === 0) return null;
  const delta = current - reference;
  const pct = Math.round((delta / reference) * 100);
  if (Math.abs(pct) < 3) return null; // noise — don't show tiny deltas
  const sign = delta > 0 ? '+' : '';
  const cls = delta > 0 ? 'text-danger' : 'text-success';
  return { text: `${sign}${pct}%`, cls };
}

const HistoryPanel: Component<HistoryPanelProps> = (props) => {
  const [records, setRecords] = createSignal<TraceRecord[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [expandedId, setExpandedId] = createSignal<number | null>(null);
  const [expandedHops, setExpandedHops] = createSignal<HopRecord[]>([]);

  const load = async () => {
    setLoading(true);
    try {
      // Empty destination → fetch all; otherwise fetch for this host
      const res = await (window as any).go?.main?.App?.GetHistory(props.destination, 50) ?? [];
      setRecords(res ?? []);
    } finally {
      setLoading(false);
    }
  };

  // Reload whenever destination changes or a new trace is saved
  createEffect(() => {
    props.destination;
    props.savedTraceId;
    load();
  });

  const toggleExpand = async (id: number) => {
    if (expandedId() === id) {
      setExpandedId(null);
      setExpandedHops([]);
      return;
    }
    const hops = await (window as any).go?.main?.App?.GetTrace(id) ?? [];
    setExpandedHops(hops ?? []);
    setExpandedId(id);
  };

  const handleDelete = async (e: MouseEvent, id: number) => {
    e.stopPropagation();
    await (window as any).go?.main?.App?.DeleteTrace(id);
    setRecords((prev) => prev.filter((r) => r.id !== id));
    if (expandedId() === id) {
      setExpandedId(null);
      setExpandedHops([]);
    }
  };

  const handleLoad = async (e: MouseEvent, record: TraceRecord) => {
    e.stopPropagation();
    const hops = await (window as any).go?.main?.App?.GetTrace(record.id) ?? [];
    props.onLoadTrace(hops ?? [], record);
  };

  return (
    <div class="border-t border-surface-200 bg-surface-50 flex flex-col min-h-0 max-h-64 overflow-y-auto">
      {/* Header */}
      <div class="flex items-center justify-between px-4 py-2.5 border-b border-surface-200 sticky top-0 bg-surface-50 z-10">
        <div class="flex items-center gap-2">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-ink-tertiary">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <span class="text-xs font-medium text-ink-secondary">
            {props.destination
              ? <><span class="text-ink-tertiary">History — </span><span class="font-mono">{props.destination}</span></>
              : 'All history'
            }
          </span>
        </div>
        <button
          onClick={props.onClose}
          class="w-5 h-5 flex items-center justify-center rounded text-ink-tertiary hover:text-ink-secondary hover:bg-surface-200 transition-colors"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>

      {/* Body */}
      <Show when={!loading()} fallback={
        <div class="flex items-center justify-center py-6">
          <div class="flex gap-1">
            <div class="w-1 h-1 rounded-full bg-ink-tertiary pulse-dot" style={{ 'animation-delay': '0ms' }} />
            <div class="w-1 h-1 rounded-full bg-ink-tertiary pulse-dot" style={{ 'animation-delay': '150ms' }} />
            <div class="w-1 h-1 rounded-full bg-ink-tertiary pulse-dot" style={{ 'animation-delay': '300ms' }} />
          </div>
        </div>
      }>
        <Show
          when={records().length > 0}
          fallback={
            <div class="flex items-center justify-center py-8">
              <p class="text-xs text-ink-tertiary">
                {props.destination ? `No history yet for ${props.destination}` : 'No traces recorded yet'}
              </p>
            </div>
          }
        >
          <For each={records()}>
            {(record, i) => {
              const delta = rttDeltaLabel(record.totalRtt, i() === 0 ? null : records()[0].totalRtt);
              const isExpanded = () => expandedId() === record.id;

              return (
                <div class="border-b border-surface-200 last:border-0">
                  {/* Summary row */}
                  <div
                    class="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-surface-100 transition-colors group"
                    onClick={() => toggleExpand(record.id)}
                  >
                    {/* Expand chevron */}
                    <svg
                      width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"
                      class={`text-ink-tertiary shrink-0 transition-transform duration-150 ${isExpanded() ? 'rotate-90' : ''}`}
                    >
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>

                    {/* Time */}
                    <span class="text-xs text-ink-tertiary w-16 shrink-0">{formatTime(record.createdAt)}</span>

                    {/* Destination pill — only shown in global "all history" mode */}
                    <Show when={!props.destination}>
                      <span class="font-mono text-xs text-ink-secondary bg-surface-200 px-1.5 py-0.5 rounded shrink-0 max-w-[140px] truncate">
                        {record.destination}
                      </span>
                    </Show>

                    {/* Hop count */}
                    <span class="text-xs text-ink-secondary">
                      <span class="font-medium">{record.hopCount}</span>
                      <span class="text-ink-tertiary"> hops</span>
                      <Show when={record.timeoutCount > 0}>
                        <span class="text-ink-tertiary"> · {record.timeoutCount} timeout{record.timeoutCount > 1 ? 's' : ''}</span>
                      </Show>
                    </span>

                    {/* RTT */}
                    <span class="font-mono text-xs text-ink-secondary ml-auto shrink-0">
                      {record.totalRtt > 0 ? `${record.totalRtt.toFixed(1)} ms` : '—'}
                    </span>

                    {/* Delta vs most recent */}
                    <Show when={delta}>
                      <span class={`font-mono text-xs font-medium w-12 text-right shrink-0 ${delta!.cls}`}>
                        {delta!.text}
                      </span>
                    </Show>

                    {/* Actions — show on hover */}
                    <div class="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                      <button
                        title="Load this trace"
                        onClick={(e) => handleLoad(e, record)}
                        class="w-5 h-5 flex items-center justify-center rounded text-ink-tertiary hover:text-accent hover:bg-accent/8 transition-colors"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.34"/>
                        </svg>
                      </button>
                      <button
                        title="Delete"
                        onClick={(e) => handleDelete(e, record.id)}
                        class="w-5 h-5 flex items-center justify-center rounded text-ink-tertiary hover:text-danger hover:bg-danger/8 transition-colors"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                          <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
                        </svg>
                      </button>
                    </div>
                  </div>

                  {/* Expanded hop list */}
                  <Show when={isExpanded()}>
                    <div class="px-4 pb-2 pt-1 bg-white border-t border-surface-100">
                      <For each={expandedHops()}>
                        {(hop) => (
                          <div class="flex items-center gap-3 py-1 text-xs">
                            <span class="font-mono text-ink-tertiary w-5 text-right shrink-0">{hop.ttl}</span>
                            <Show
                              when={hop.success}
                              fallback={<span class="text-ink-disabled">*</span>}
                            >
                              <span class="font-mono text-ink truncate">
                                {hop.hostname && hop.hostname !== hop.ip ? hop.hostname : hop.ip}
                              </span>
                              <span class={`font-mono ml-auto shrink-0 ${hop.rtt < 30 ? 'text-success' : hop.rtt < 100 ? 'text-warning' : 'text-danger'}`}>
                                {hop.rtt.toFixed(1)} ms
                              </span>
                            </Show>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </Show>
    </div>
  );
};

export default HistoryPanel;
