'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { isStopSupported } from '@/lib/version';
import { useToastStore } from '@/store/toast';

interface PsModelDetails {
  family?: string;
  families?: string[];
  parameter_size?: string;
  quantization_level?: string;
}

interface PsModel {
  name: string;
  model?: string;
  size?: number;
  size_vram?: number;
  digest?: string;
  details?: PsModelDetails;
  expires_at?: string;
  context_length?: number;
}

interface PsResponse {
  models: PsModel[];
}

async function fetchPs(): Promise<PsResponse> {
  const r = await fetch('/api/ps', { cache: 'no-store' });
  if (!r.ok) throw new Error('Failed to load running models');
  const j = await r.json();
  return { models: Array.isArray(j.models) ? j.models : [] };
}

async function fetchVersion(): Promise<string | null> {
  const r = await fetch('/api/version', { cache: 'no-store' });
  if (!r.ok) return null;
  const j = await r.json();
  return typeof j.version === 'string' ? j.version : null;
}

function formatSize(bytes?: number): string {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Mirrors Ollama's own `ollama ps` PROCESSOR column: how much of the model
// currently sits in VRAM vs. system RAM.
function processorSplit(m: PsModel): { cpuPct: number; gpuPct: number; label: string } {
  const size = m.size || 0;
  const vram = m.size_vram || 0;
  if (size <= 0) return { cpuPct: 0, gpuPct: 0, label: '—' };
  const gpuPct = Math.max(0, Math.min(100, Math.round((vram / size) * 100)));
  const cpuPct = 100 - gpuPct;
  if (gpuPct >= 100) return { cpuPct: 0, gpuPct: 100, label: '100% GPU' };
  if (gpuPct <= 0) return { cpuPct: 100, gpuPct: 0, label: '100% CPU' };
  return { cpuPct, gpuPct, label: `${cpuPct}% CPU / ${gpuPct}% GPU` };
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Ollama only evicts a model once it's actually idle — a request still being
// served keeps it resident even past its nominal expiry, so "expired" here
// does NOT mean an unload is in progress; it means the model is busy enough
// that the idle sweep hasn't had a chance to run yet.
function formatUnloadStatus(expiresAt: string | undefined, now: number): string {
  if (!expiresAt) return '—';
  const target = new Date(expiresAt).getTime();
  if (Number.isNaN(target)) return '—';
  const diffSec = Math.floor((target - now) / 1000);
  if (diffSec <= 0) return 'busy — won’t unload until idle';
  const h = Math.floor(diffSec / 3600);
  const m = Math.floor((diffSec % 3600) / 60);
  const s = diffSec % 60;
  if (h > 0) return `unloads in ${h}h ${m}m`;
  if (m > 0) return `unloads in ${m}m ${s.toString().padStart(2, '0')}s`;
  return `unloads in ${s}s`;
}

export default function RunningPage() {
  const queryClient = useQueryClient();
  const pushToast = useToastStore((s) => s.push);
  const now = useNow(1000);
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Set<string>>(new Set());

  const {
    data: ps,
    isLoading,
    isError,
    error,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['ollama-ps-page'],
    queryFn: fetchPs,
    refetchInterval: 4000,
    refetchOnWindowFocus: true,
  });

  const { data: version } = useQuery({
    queryKey: ['ollama-version'],
    queryFn: fetchVersion,
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  async function loadActiveHost() {
    try {
      const r = await fetch('/api/hosts');
      if (!r.ok) throw new Error('Failed to load hosts');
      const j = await r.json();
      if (Array.isArray(j.hosts)) {
        interface HostRow {
          active?: number | boolean;
          url: string;
        }
        const active = (j.hosts as HostRow[]).find((h) => !!h.active);
        setActiveHost(active ? active.url : null);
      }
    } catch {
      setActiveHost(null);
    }
  }
  useEffect(() => {
    loadActiveHost();
  }, []);
  useEffect(() => {
    function onActiveChange() {
      loadActiveHost();
      queryClient.invalidateQueries({ queryKey: ['ollama-ps-page'] });
    }
    window.addEventListener('active-host-changed', onActiveChange as EventListener);
    return () => window.removeEventListener('active-host-changed', onActiveChange as EventListener);
  }, [queryClient]);

  const models = ps?.models ?? [];
  const stopSupported = version ? isStopSupported(version) : false;
  const totalVram = models.reduce((sum, m) => sum + (m.size_vram || 0), 0);
  const totalRam = models.reduce(
    (sum, m) => sum + Math.max(0, (m.size || 0) - (m.size_vram || 0)),
    0,
  );

  async function handleStop(modelName: string) {
    setStopping((prev) => new Set(prev).add(modelName));
    try {
      const res = await fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to stop model');
      }
      await new Promise((r) => setTimeout(r, 500));
      await refetch();
      window.dispatchEvent(new CustomEvent('active-host-changed'));
      pushToast({ type: 'success', message: `${modelName} unloaded.` });
    } catch (e) {
      pushToast({
        type: 'error',
        message: e instanceof Error ? e.message : 'Failed to stop model',
      });
    } finally {
      setStopping((prev) => {
        const next = new Set(prev);
        next.delete(modelName);
        return next;
      });
    }
  }

  return (
    <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-10 py-14">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Live status
        </span>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-gradient-hero">Running Models</h1>
          <Button
            onClick={() => refetch()}
            variant="outline"
            size="sm"
            loading={isFetching}
            title="Refresh now"
          >
            Refresh
          </Button>
          {version && (
            <span className="cap-pill border-white/15 bg-white/5 text-white/50">
              Ollama v{version}
            </span>
          )}
          <span className="text-[10px] font-mono text-white/25">auto-refreshing every 4s</span>
        </div>
      </div>

      {!activeHost && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-200">
          No active host configured.{' '}
          <Link href="/settings" className="underline hover:text-yellow-100">
            Add and activate one under Settings → Ollama Host
          </Link>
          .
        </div>
      )}

      {isError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          Error loading: {(error as Error).message}
        </div>
      )}

      {isLoading && activeHost && (
        <div className="text-white/50 animate-pulse">Loading running models…</div>
      )}

      {activeHost && !isLoading && !isError && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="glass-card p-4 flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
                Loaded models
              </span>
              <span className="text-2xl font-bold tabular-nums text-white/90">{models.length}</span>
            </div>
            <div className="glass-card p-4 flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
                VRAM in use
              </span>
              <span className="text-2xl font-bold tabular-nums text-white/90">
                {formatSize(totalVram)}
              </span>
            </div>
            <div className="glass-card p-4 flex flex-col gap-1">
              <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
                System RAM in use
              </span>
              <span className="text-2xl font-bold tabular-nums text-white/90">
                {formatSize(totalRam)}
              </span>
            </div>
          </div>

          {models.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-white/50">
              No models currently loaded. They load automatically on first use.
            </div>
          ) : (
            <motion.ul
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="flex flex-col gap-3"
            >
              {models.map((m) => {
                const split = processorSplit(m);
                const isStopping = stopping.has(m.name);
                return (
                  <li
                    key={m.name}
                    className="rounded-xl border border-white/10 bg-white/[0.04] p-5 transition hover:border-indigo-400/30 hover:bg-white/[0.06]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="font-semibold text-white/90 tracking-tight truncate">
                          {m.name}
                        </h2>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {m.details?.parameter_size && (
                            <span className="cap-pill border-white/15 bg-white/5 text-white/50 !text-[10px]">
                              {m.details.parameter_size}
                            </span>
                          )}
                          {m.details?.quantization_level && (
                            <span className="cap-pill border-white/15 bg-white/5 text-white/50 !text-[10px]">
                              {m.details.quantization_level}
                            </span>
                          )}
                          {m.details?.family && (
                            <span className="cap-pill border-white/15 bg-white/5 text-white/50 !text-[10px]">
                              {m.details.family}
                            </span>
                          )}
                          {typeof m.context_length === 'number' && m.context_length > 0 && (
                            <span
                              className="cap-pill border-white/15 bg-white/5 text-white/50 !text-[10px]"
                              title="Effective running context window (num_ctx)"
                            >
                              ctx {m.context_length.toLocaleString()}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 shrink-0">
                        <div className="text-right">
                          <div className="text-xs font-mono text-white/60">{split.label}</div>
                          <div className="text-[10px] text-white/30">
                            {formatSize(m.size)}
                            {m.size_vram ? ` · VRAM ${formatSize(m.size_vram)}` : ''}
                          </div>
                        </div>
                        {stopSupported ? (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleStop(m.name)}
                            disabled={isStopping}
                            loading={isStopping}
                            title="Unload this model from memory"
                          >
                            Unload
                          </Button>
                        ) : (
                          <span
                            className="text-[10px] text-yellow-400/70"
                            title="Requires Ollama v0.1.33+"
                          >
                            v0.1.33+ req.
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                        <div
                          className="h-full bg-[rgb(var(--accent-glow))] shadow-[0_0_8px_rgb(var(--accent-glow)/0.6)] transition-[width]"
                          style={{ width: `${split.gpuPct}%` }}
                          title={`${split.gpuPct}% GPU`}
                        />
                      </div>
                      <span className="text-[10px] font-mono text-white/30 shrink-0">
                        {formatUnloadStatus(m.expires_at, now)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </motion.ul>
          )}
        </>
      )}
    </div>
  );
}
