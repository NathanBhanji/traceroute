import type { Component } from 'solid-js';
import { For, Show, createMemo } from 'solid-js';
import HopRow from './HopRow';
import type { HopData } from '../types';

interface HopTableProps {
  hops: HopData[];
  isRunning: boolean;
  destination: string;
}

const HopTable: Component<HopTableProps> = (props) => {
  // Scale everything to the slowest hop
  const maxRtt = createMemo(() => {
    const rtts = props.hops.filter((h) => h.success).map((h) => h.rtt);
    return rtts.length > 0 ? Math.max(...rtts, 1) : 1;
  });

  const successCount = createMemo(() => props.hops.filter((h) => h.success).length);
  const timeoutCount = createMemo(() => props.hops.filter((h) => !h.success).length);
  const totalRtt = createMemo(() => {
    const last = [...props.hops].reverse().find((h) => h.success);
    return last ? last.rtt : null;
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
      <div class="flex-1 overflow-y-auto py-1">
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
          <For each={props.hops}>
            {(hop, i) => (
              <HopRow
                hop={hop}
                index={i()}
                maxRtt={maxRtt()}
              />
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
              <span class="text-xs text-ink-tertiary">total</span>
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

export default HopTable;
