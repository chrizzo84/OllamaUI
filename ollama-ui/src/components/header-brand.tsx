'use client';
import { useEffect, useState } from 'react';
import { HostManagerModal } from '@/components/host-manager-modal';

interface HostState {
  url: string | null;
  label?: string | null;
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
    label: null,
    loading: true,
    error: null,
    reachable: null,
  });
  const [refreshIdx, setRefreshIdx] = useState(0);
  const [openManager, setOpenManager] = useState(false);

  // Listen for global active host change events (refresh) and modal open requests
  useEffect(() => {
    function handler() {
      setRefreshIdx((i) => i + 1);
    }
    function openHandler() {
      setOpenManager(true);
    }
    window.addEventListener('active-host-changed', handler as EventListener);
    window.addEventListener('open-host-manager', openHandler as EventListener);
    return () => {
      window.removeEventListener('active-host-changed', handler as EventListener);
      window.removeEventListener('open-host-manager', openHandler as EventListener);
    };
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
        const label = active?.label || null;
        if (aborted) return;
        if (!url) {
          setState({ url: null, label: null, loading: false, error: null, reachable: null });
          return;
        }
        const controller = new AbortController();
        const test = await testHost(url, controller.signal);
        if (aborted) return;
        setState({
          url,
          label,
          loading: false,
          error: null,
          reachable: test.ok,
          latency: test.latency,
        });
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
    <>
      <div className="flex items-center gap-2">
        <div
          className={`${pillBase} ${pillStyle} cursor-default select-text !px-3 inline-flex`}
          role="status"
          aria-live={state.loading ? 'polite' : 'off'}
          title={
            state.url
              ? `Active host: ${state.url}${state.label ? ` (${state.label})` : ''}`
              : 'No active host configured'
          }
          data-host-full={state.url || ''}
        >
          {state.loading && <span>Host…</span>}
          {!state.loading && !state.url && <span>No host</span>}
          {!state.loading && state.url && (
            <>
              <span className="font-mono whitespace-nowrap">
                {state.url.replace(/^https?:\/\//, '')}
              </span>
              {state.label && (
                <span className="text-[9px] uppercase tracking-wide opacity-60">{state.label}</span>
              )}
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
        </div>
        <button
          type="button"
          onClick={() => setOpenManager(true)}
          className="h-7 w-7 rounded-md border border-indigo-400/40 bg-indigo-500/20 text-indigo-200 hover:text-white hover:border-indigo-300 hover:bg-indigo-500/30 text-[13px] font-semibold flex items-center justify-center shadow-sm"
          title="Manage / switch hosts"
          aria-label="Manage hosts"
        >
          ⚙
        </button>
        <button
          type="button"
          onClick={() => setRefreshIdx((i) => i + 1)}
          className="h-7 w-7 rounded-md border border-white/15 bg-white/10 text-white/70 hover:text-white hover:border-white/40 hover:bg-white/15 text-[13px] flex items-center justify-center"
          title="Retest active host"
        >
          ↻
        </button>
      </div>
      <HostManagerModal
        open={openManager}
        onClose={() => setOpenManager(false)}
        onActivated={() => {
          setOpenManager(false);
          setRefreshIdx((i) => i + 1);
        }}
      />
    </>
  );
}
