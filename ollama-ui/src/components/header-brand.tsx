'use client';
import { useEffect, useState } from 'react';

interface HostState {
  url: string | null;
  loading: boolean;
  error: string | null;
  reachable: boolean | null;
  latency?: number;
}

async function testHost(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; latency?: number }> {
  const start = Date.now();
  try {
    const res = await fetch('/api/hosts/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
      signal,
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j.ok) return { ok: true, latency: j.latency ?? Date.now() - start };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export function HostIndicator() {
  const [state, setState] = useState<HostState>({
    url: null,
    loading: true,
    error: null,
    reachable: null,
  });
  const [refreshIdx, setRefreshIdx] = useState(0);

  // Listen for global active host change events dispatched from models page to trigger immediate refresh
  useEffect(() => {
    function handler(e: Event) {
      setRefreshIdx((i) => i + 1);
    }
    window.addEventListener('active-host-changed', handler as EventListener);
    return () => window.removeEventListener('active-host-changed', handler as EventListener);
  }, []);

  useEffect(() => {
    let aborted = false;
    async function load() {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        // We derive active host via /api/hosts list (server authoritative)
        const r = await fetch('/api/hosts', { cache: 'no-store' });
        if (!r.ok) throw new Error('Failed to load hosts');
        const j = await r.json();
        interface HostsApiRow {
          id: string;
          url: string;
          label?: string | null;
          active: number;
        }
        const active = Array.isArray(j.hosts)
          ? (j.hosts as HostsApiRow[]).find((h) => !!h.active)
          : null;
        const url = active?.url || null;
        if (aborted) return;
        if (!url) {
          setState({ url: null, loading: false, error: null, reachable: null });
          return;
        }
        const controller = new AbortController();
        const test = await testHost(url, controller.signal);
        if (aborted) return;
        setState({ url, loading: false, error: null, reachable: test.ok, latency: test.latency });
      } catch (e: unknown) {
        if (aborted) return;
        setState((s) => ({ ...s, loading: false, error: (e as Error).message, reachable: null }));
      }
    }
    load();
    return () => {
      aborted = true;
    };
  }, [refreshIdx]);

  const pillBase =
    'rounded-full px-2.5 py-1 flex items-center gap-2 text-[11px] font-medium border backdrop-blur';
  let pillStyle = 'border-white/15 bg-white/5 text-white/50';
  if (state.loading) pillStyle = 'border-white/15 bg-white/5 text-white/40 animate-pulse';
  else if (!state.url) pillStyle = 'border-yellow-500/40 bg-yellow-500/10 text-yellow-200';
  else if (state.reachable === true)
    pillStyle = 'border-green-500/40 bg-green-500/10 text-green-200';
  else if (state.reachable === false) pillStyle = 'border-red-500/40 bg-red-500/10 text-red-200';

  return (
    <button
      type="button"
      onClick={() => setRefreshIdx((i) => i + 1)}
      className={`${pillBase} ${pillStyle}`}
      title="Active Ollama host (click to retest)"
    >
      {state.loading && <span>Host…</span>}
      {!state.loading && !state.url && <span>No host</span>}
      {!state.loading && state.url && (
        <>
          <span className="max-w-[140px] truncate font-mono">
            {state.url.replace(/^https?:\/\//, '')}
          </span>
          {state.reachable === true && (
            <span className="text-[9px] uppercase tracking-wide opacity-70">
              OK{typeof state.latency === 'number' ? ` ${state.latency}ms` : ''}
            </span>
          )}
          {state.reachable === false && (
            <span className="text-[9px] uppercase tracking-wide opacity-70">DOWN</span>
          )}
        </>
      )}
    </button>
  );
}
