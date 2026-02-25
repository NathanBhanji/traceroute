import { createSignal, createMemo, Show, For, onMount, onCleanup } from 'solid-js';
import type { Component } from 'solid-js';

const HISTORY_KEY = 'traceroute:history';
const MAX_HISTORY = 50;

function loadHistory(): string[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function saveToHistory(host: string) {
  const prev = loadHistory().filter((h) => h !== host);
  const next = [host, ...prev].slice(0, MAX_HISTORY);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
}

interface SearchBarProps {
  /** Called when user picks a host (Enter / click suggestion) */
  onCommit: (host: string) => void;
  /** Called on every keystroke so parent can track current input value */
  onHostChange?: (host: string) => void;
  onStop: () => void;
  isRunning: boolean;
}

const SearchBar: Component<SearchBarProps> = (props) => {
  const [host, setHost] = createSignal('');

  // All known hosts: history (MRU first) + /etc/hosts seeds (deduped)
  const [allSuggestions, setAllSuggestions] = createSignal<string[]>([]);
  const [showDropdown, setShowDropdown] = createSignal(false);
  const [activeIdx, setActiveIdx] = createSignal(-1);

  // Filtered list based on current input
  const suggestions = createMemo(() => {
    const q = host().trim().toLowerCase();
    if (!q) return allSuggestions().slice(0, 8); // show recent 8 when empty
    return allSuggestions()
      .filter((s) => s.toLowerCase().includes(q) && s.toLowerCase() !== q)
      .slice(0, 8);
  });

  onMount(async () => {
    const history = loadHistory();
    // Seed with /etc/hosts from Go backend (if available)
    try {
      const etcHosts: string[] = await (window as any).go?.main?.App?.GetHostSuggestions() ?? [];
      // Merge: history first (MRU), then /etc/hosts entries not already in history
      const historySet = new Set(history);
      const merged = [...history, ...etcHosts.filter((h) => !historySet.has(h))];
      setAllSuggestions(merged);
    } catch {
      setAllSuggestions(history);
    }
  });

  const commit = (value: string) => {
    const h = value.trim();
    if (!h) return;
    saveToHistory(h);
    setAllSuggestions((prev) => {
      const without = prev.filter((s) => s !== h);
      return [h, ...without];
    });
    setHost(h);
    setShowDropdown(false);
    setActiveIdx(-1);
    props.onCommit(h);
  };

  const handleSubmit = () => {
    if (activeIdx() >= 0 && suggestions()[activeIdx()]) {
      commit(suggestions()[activeIdx()]);
    } else {
      commit(host());
    }
  };

  const handleInput = (e: InputEvent) => {
    const val = (e.currentTarget as HTMLInputElement).value;
    setHost(val);
    setActiveIdx(-1);
    setShowDropdown(true);
    props.onHostChange?.(val);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    const list = suggestions();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setShowDropdown(true);
      setActiveIdx((i) => Math.min(i + 1, list.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, -1));
      return;
    }
    if (e.key === 'Tab' && list.length > 0) {
      e.preventDefault();
      const pick = list[activeIdx() >= 0 ? activeIdx() : 0];
      setHost(pick);
      setActiveIdx(-1);
      setShowDropdown(false);
      return;
    }
    if (e.key === 'Escape') {
      if (showDropdown()) {
        setShowDropdown(false);
        setActiveIdx(-1);
      } else if (props.isRunning) {
        props.onStop();
      }
      return;
    }
    if (e.key === 'Enter') {
      handleSubmit();
    }
  };

  // Close dropdown when clicking outside
  let containerRef: HTMLDivElement | undefined;
  const handleClickOutside = (e: MouseEvent) => {
    if (containerRef && !containerRef.contains(e.target as Node)) {
      setShowDropdown(false);
      setActiveIdx(-1);
    }
  };
  onMount(() => document.addEventListener('mousedown', handleClickOutside));
  onCleanup(() => document.removeEventListener('mousedown', handleClickOutside));

  return (
    <div class="relative flex-1" ref={containerRef}>
      {/* Globe icon */}
      <div class="absolute inset-y-0 left-3.5 flex items-center pointer-events-none z-10">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-ink-tertiary">
          <circle cx="12" cy="12" r="10"/>
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </div>

      <input
        type="text"
        value={host()}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onFocus={() => setShowDropdown(true)}
        placeholder="Hostname or IP address — e.g. google.com"
        disabled={props.isRunning}
        autocomplete="off"
        spellcheck={false}
        class={`w-full h-11 pl-10 pr-4 rounded-xl border text-sm font-sans transition-all duration-150 outline-none
          font-[450] placeholder:text-ink-tertiary placeholder:font-normal
          ${props.isRunning
            ? 'bg-surface-100 border-surface-200 text-ink-tertiary cursor-not-allowed'
            : 'bg-white border-surface-200 text-ink hover:border-surface-300 focus:border-accent focus:ring-2 focus:ring-accent/10'
          }`}
      />

      {/* Dropdown */}
      <Show when={showDropdown() && suggestions().length > 0 && !props.isRunning}>
        <div class="absolute left-0 right-0 top-[calc(100%+4px)] z-50 bg-white border border-surface-200 rounded-xl shadow-lg overflow-hidden">
          <For each={suggestions()}>
            {(suggestion, i) => {
              const q = host().trim().toLowerCase();
              const matchIdx = suggestion.toLowerCase().indexOf(q);
              const before = q && matchIdx >= 0 ? suggestion.slice(0, matchIdx) : suggestion;
              const match  = q && matchIdx >= 0 ? suggestion.slice(matchIdx, matchIdx + q.length) : '';
              const after  = q && matchIdx >= 0 ? suggestion.slice(matchIdx + q.length) : '';

              return (
                <div
                  class={`flex items-center gap-3 px-3.5 py-2.5 cursor-pointer transition-colors duration-75 select-none
                    ${i() === activeIdx() ? 'bg-accent/6' : 'hover:bg-surface-100'}`}
                  onMouseDown={(e) => { e.preventDefault(); commit(suggestion); }}
                  onMouseEnter={() => setActiveIdx(i())}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" class="text-ink-tertiary shrink-0">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                  </svg>
                  <span class="font-mono text-sm text-ink truncate">
                    {before}
                    <Show when={match}>
                      <span class="text-accent font-semibold">{match}</span>
                    </Show>
                    {after}
                  </span>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

export default SearchBar;
