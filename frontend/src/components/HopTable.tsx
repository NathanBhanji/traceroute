import type { Component } from 'solid-js';
import { For, Show, createMemo, createEffect, createSignal } from 'solid-js';
import HopRow from './HopRow';
import type { HopData } from '../types';

interface HopTableProps {
  hops: HopData[];
  isRunning: boolean;
  destination: string;
}

interface TimeoutGroup {
  kind: 'timeouts';
  ttls: number[];
}
interface HopItem {
  kind: 'hop';
  hop: HopData;
  index: number; // visual index for animation delay
}
type Row = HopItem | TimeoutGroup;

const HopTable: Component<HopTableProps> = (props) => {
  let scrollRef: HTMLDivElement | undefined;

  // Scale everything to the slowest hop
  const maxRtt = createMemo(() => {
    const rtts = props.hops.filter((h) => h.success).map((h) => h.rtt);
    return rtts.length > 0 ? Math.max(...rtts, 1) : 1;
  });

  const successCount = createMemo(() => props.hops.filter((h) => h.success && !h.isPending).length);
  const timeoutCount = createMemo(() => props.hops.filter((h) => !h.success && !h.isPending).length);
  const totalRtt = createMemo(() => {
    const last = [...props.hops].reverse().find((h) => h.success && !h.isPending);
    return last ? last.rtt : null;
  });

  // Collapse consecutive timeout runs into single summary rows.
  // Pending (skeleton) hops are shown as individual rows during probing.
  const rows = createMemo<Row[]>(() => {
    const result: Row[] = [];
    let hopIndex = 0;
    let i = 0;
    const hops = props.hops;

    while (i < hops.length) {
      const hop = hops[i];

      // Keep pending skeletons as individual rows so shimmer is visible
      if (hop.isPending) {
        result.push({ kind: 'hop', hop, index: hopIndex++ });
        i++;
        continue;
      }

      // Collect a run of timeouts
      if (!hop.success) {
        const group: number[] = [];
        while (i < hops.length && !hops[i].success && !hops[i].isPending) {
          group.push(hops[i].ttl);
          i++;
        }
        result.push({ kind: 'timeouts', ttls: group });
        continue;
      }

      result.push({ kind: 'hop', hop, index: hopIndex++ });
      i++;
    }

    return result;
  });

  // Scroll to bottom when trace finishes
  createEffect(() => {
    const running = props.isRunning;
    const count = props.hops.length;
    if (!running && count > 0 && scrollRef) {
      // rAF so the DOM has painted the final rows first
      requestAnimationFrame(() => {
        scrollRef!.scrollTo({ top: scrollRef!.scrollHeight, behavior: 'smooth' });
      });
    }
  });

  return (
    <div class="flex-1 flex flex-col min-h-0">
      {/* Table header */}
      <div
        class="grid px-4 pb-2 text-xs font-medium text-ink-tertiary uppercase tracking-wider border-b border-surface-200"
        style={{ 'grid-template-columns': '2.5rem 1fr 1fr 7rem' }}
      >
        <div>#</div>
        <div>Host</div>
        <div>Waterfall</div>
        <div class="text-right">RTT</div>
      </div>

      {/* Hop rows */}
      <div ref={scrollRef} class="flex-1 overflow-y-auto py-1">
        <Show
          when={props.hops.length > 0}
          fallback={
            <Show when={!props.isRunning}>
              <div class="flex flex-col items-center justify-center h-full text-center py-16">
                <div class="w-12 h-12 rounded-2xl bg-surface-100 border border-surface-200 flex items-center justify-center mb-4">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-ink-tertiary">
                    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                  </svg>
                </div>
                <p class="text-sm font-medium text-ink-secondary">No trace yet</p>
                <p class="text-xs text-ink-tertiary mt-1">Enter a hostname above and click Trace</p>
              </div>
            </Show>
          }
        >
          <For each={rows()}>
            {(row) => (
              <Show
                when={row.kind === 'hop'}
                fallback={
                  <TimeoutGroupRow ttls={(row as TimeoutGroup).ttls} />
                }
              >
                <HopRow
                  hop={(row as HopItem).hop}
                  index={(row as HopItem).index}
                  maxRtt={maxRtt()}
                />
              </Show>
            )}
          </For>
        </Show>

        {/* Running indicator */}
        <Show when={props.isRunning}>
          <div class="flex items-center gap-3 px-4 py-3">
            <div class="flex gap-1">
              <div class="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" style={{ 'animation-delay': '0ms' }} />
              <div class="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" style={{ 'animation-delay': '200ms' }} />
              <div class="w-1.5 h-1.5 rounded-full bg-accent pulse-dot" style={{ 'animation-delay': '400ms' }} />
            </div>
            <span class="text-xs text-ink-tertiary">
              Tracing{props.destination ? ` ${props.destination}` : ''}…
            </span>
          </div>
        </Show>
      </div>

      {/* Summary footer */}
      <Show when={props.hops.length > 0 && !props.isRunning}>
        <div class="border-t border-surface-200 px-4 py-3 flex items-center gap-5">
          <div class="flex items-center gap-1.5">
            <div class="w-1.5 h-1.5 rounded-full bg-success" />
            <span class="text-xs text-ink-tertiary">
              <span class="font-medium text-ink-secondary">{successCount()}</span> hops
            </span>
          </div>
          <Show when={timeoutCount() > 0}>
            <div class="flex items-center gap-1.5">
              <div class="w-1.5 h-1.5 rounded-full bg-ink-disabled" />
              <span class="text-xs text-ink-tertiary">
                <span class="font-medium text-ink-secondary">{timeoutCount()}</span> timeouts
              </span>
            </div>
          </Show>
          <Show when={totalRtt() !== null}>
            <div class="flex items-center gap-1.5 ml-auto">
              <span class="text-xs text-ink-tertiary">dest RTT</span>
              <span class="font-mono text-xs font-medium text-ink-secondary">
                {totalRtt()!.toFixed(1)} ms
              </span>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

// Collapsed row for a run of consecutive timeouts
const TimeoutGroupRow: Component<{ ttls: number[] }> = (props) => {
  const [expanded, setExpanded] = createSignal(false);

  const label = () => {
    const n = props.ttls.length;
    const first = props.ttls[0];
    const last = props.ttls[props.ttls.length - 1];
    return n === 1 ? `TTL ${first}` : `TTL ${first}–${last}`;
  };

  return (
    <Show
      when={!expanded()}
      fallback={
        // Expanded: show each timeout row individually + a collapse button
        <div>
          <For each={props.ttls}>
            {(ttl, i) => (
              <div
                class="grid items-center py-2 px-4 rounded-xl"
                style={{ 'grid-template-columns': '2.5rem 1fr 1fr 7rem' }}
              >
                <div class="font-mono text-sm font-medium text-ink-disabled tabular-nums">{ttl}</div>
                <div><span class="font-mono text-sm text-ink-disabled">*</span></div>
                <div>
                  <div class="h-[3px] w-full rounded-full" style={{ background: 'repeating-linear-gradient(90deg, #e4e4e7 0px, #e4e4e7 4px, transparent 4px, transparent 8px)' }} />
                </div>
                <div class="flex justify-end">
                  <Show when={i() === 0}>
                    <button
                      onClick={() => setExpanded(false)}
                      class="font-mono text-xs text-ink-disabled hover:text-ink-tertiary transition-colors"
                      title="Collapse timeouts"
                    >
                      ↑ hide
                    </button>
                  </Show>
                </div>
              </div>
            )}
          </For>
        </div>
      }
    >
      {/* Collapsed: single summary pill */}
      <div
        class="grid items-center py-2 px-4 rounded-xl hover:bg-surface-100 transition-colors duration-100 cursor-pointer group"
        style={{ 'grid-template-columns': '2.5rem 1fr 1fr 7rem' }}
        onClick={() => setExpanded(true)}
        title="Click to expand timeouts"
      >
        {/* TTL range */}
        <div class="font-mono text-xs text-ink-disabled tabular-nums">{props.ttls[0]}</div>

        {/* Label */}
        <div class="flex items-center gap-2">
          <span class="font-mono text-xs text-ink-disabled">*</span>
          <span class="text-xs text-ink-disabled group-hover:text-ink-tertiary transition-colors">
            {props.ttls.length === 1 ? '1 timeout' : `${props.ttls.length} timeouts`}
          </span>
        </div>

        {/* Dashed line, dimmer */}
        <div class="pr-5">
          <div class="h-[2px] w-full rounded-full opacity-40" style={{ background: 'repeating-linear-gradient(90deg, #e4e4e7 0px, #e4e4e7 4px, transparent 4px, transparent 8px)' }} />
        </div>

        {/* Expand hint */}
        <div class="flex justify-end">
          <span class="font-mono text-xs text-ink-disabled opacity-0 group-hover:opacity-100 transition-opacity">
            {label()} ↓
          </span>
        </div>
      </div>
    </Show>
  );
};

export default HopTable;
