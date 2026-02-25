import type { Component } from 'solid-js';
import { Show } from 'solid-js';
import type { HopData } from '../types';

interface HopRowProps {
  hop: HopData;
  index: number;
  maxRtt: number; // slowest hop RTT — used to scale all bars
}

function barColor(rtt: number): string {
  if (rtt < 30)  return '#22c55e';
  if (rtt < 100) return '#f59e0b';
  return '#ef4444';
}

function rttTextColor(rtt: number): string {
  if (rtt < 30)  return 'text-success';
  if (rtt < 100) return 'text-warning';
  return 'text-danger';
}

function formatRtt(rtt: number): string {
  if (rtt < 1) return `${(rtt * 1000).toFixed(0)} μs`;
  return `${rtt.toFixed(1)} ms`;
}

const HopRow: Component<HopRowProps> = (props) => {
  const animDelay = () => `${Math.min(props.index * 30, 300)}ms`;
  const barWidth  = () => `${Math.max((props.hop.rtt / Math.max(props.maxRtt, 1)) * 100, 1)}%`;

  return (
    <div
      class="hop-row grid items-center py-2.5 px-4 rounded-xl hover:bg-surface-100 transition-colors duration-100"
      style={{ 'animation-delay': animDelay(), 'grid-template-columns': '2.5rem 1fr 1fr 7rem' }}
    >
      {/* TTL */}
      <div class="font-mono text-sm font-medium text-ink-tertiary tabular-nums">
        {props.hop.ttl}
      </div>

      {/* Host / IP */}
      <div class="min-w-0 pr-6">
        <Show
          when={props.hop.success}
          fallback={<span class="font-mono text-sm text-ink-disabled">*</span>}
        >
          <Show when={props.hop.hostname && props.hop.hostname !== props.hop.ip}>
            <div class="text-sm font-medium text-ink truncate" title={props.hop.hostname}>
              {props.hop.hostname}
            </div>
            <div class="font-mono text-xs text-ink-tertiary mt-0.5 select-all">{props.hop.ip}</div>
          </Show>
          <Show when={!props.hop.hostname || props.hop.hostname === props.hop.ip}>
            <div class="font-mono text-sm font-medium text-ink select-all">{props.hop.ip}</div>
          </Show>
        </Show>
      </div>

      {/* Waterfall bar */}
      <div class="pr-5">
        <Show
          when={props.hop.success}
          fallback={
            /* timeout — show a faint dashed line */
            <div class="h-[3px] w-full rounded-full" style={{ background: 'repeating-linear-gradient(90deg, #e4e4e7 0px, #e4e4e7 4px, transparent 4px, transparent 8px)' }} />
          }
        >
          {/* Track (full width, faint) */}
          <div class="relative w-full h-[6px] rounded-full overflow-hidden" style={{ background: '#f0f0ef' }}>
            {/* Bar */}
            <div
              class="absolute left-0 top-0 h-full rounded-full transition-all duration-500"
              style={{
                width: barWidth(),
                background: barColor(props.hop.rtt),
                opacity: '0.75',
              }}
            />
          </div>
        </Show>
      </div>

      {/* RTT value */}
      <div class="flex items-center justify-end">
        <Show
          when={props.hop.success}
          fallback={<span class="font-mono text-xs text-ink-disabled">—</span>}
        >
          <span class={`font-mono text-sm tabular-nums ${rttTextColor(props.hop.rtt)}`}>
            {formatRtt(props.hop.rtt)}
          </span>
        </Show>
      </div>
    </div>
  );
};

export default HopRow;
