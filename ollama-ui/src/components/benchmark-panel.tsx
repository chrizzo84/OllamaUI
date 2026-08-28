'use client';
import { useCallback, useEffect, useState } from 'react';
import { Play, Loader2 } from 'lucide-react';
import { BenchmarkCharts, type BenchmarkRunPoint } from './benchmark-charts';

interface BenchmarkSummary {
  model: string;
  samples: number;
  avgTokensPerSecond: number;
  minTokensPerSecond: number;
  maxTokensPerSecond: number;
  lastRunAt: number;
  chatSamples: number;
  manualSamples: number;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function BenchmarkPanel() {
  const [runs, setRuns] = useState<BenchmarkRunPoint[]>([]);
  const [summary, setSummary] = useState<BenchmarkSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number; model: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/benchmarks', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      setRuns(Array.isArray(j.runs) ? j.runs : []);
      setSummary(Array.isArray(j.summary) ? j.summary : []);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRunAll() {
    if (running) return;
    setError(null);
    setRunning(true);
    try {
      const r = await fetch('/api/models', { cache: 'no-store' });
      const j = r.ok ? await r.json() : { models: [] };
      const models: string[] = Array.isArray(j.models)
        ? j.models.map((m: { name?: string }) => m.name).filter(Boolean)
        : [];
      if (models.length === 0) {
        setError('No installed models found.');
        return;
      }
      // Sequential, not parallel — one model actually running at a time
      // gives clean, comparable per-model numbers instead of several models
      // contending for the same GPU/VRAM.
      for (let i = 0; i < models.length; i++) {
        const model = models[i];
        setProgress({ done: i, total: models.length, model });
        const res = await fetch('/api/benchmarks/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          setError(`${model}: ${body.error || 'failed'}`);
        }
      }
      await refresh();
    } finally {
      setProgress(null);
      setRunning(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <p className="text-xs text-white/50 max-w-lg">
          Every real chat reply logs its speed automatically. This button additionally sends the
          same fixed prompt to every installed model, one at a time, for a direct, comparable
          measurement.
        </p>
        <button
          type="button"
          onClick={handleRunAll}
          disabled={running}
          className="inline-flex items-center gap-1.5 rounded-md border border-violet-500/25 bg-violet-500/10 px-3 py-1.5 text-xs text-violet-200/80 hover:bg-violet-500/20 transition disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Play className="h-3.5 w-3.5" />
          )}
          {running && progress
            ? `Benchmarking ${progress.done + 1}/${progress.total}: ${progress.model}…`
            : 'Run benchmark now'}
        </button>
      </div>
      {error && (
        <div className="text-[11px] text-amber-300/80 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      <div className="glass-card p-4">
        <BenchmarkCharts runs={runs} />
      </div>
      {loading ? (
        <div className="text-xs text-white/30">Loading…</div>
      ) : summary.length === 0 ? (
        <div className="text-xs text-white/30">No benchmark data yet.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-white/40 border-b border-white/10">
                <th className="py-2 pr-4 font-medium">Model</th>
                <th className="py-2 pr-4 font-medium">Avg tok/s</th>
                <th className="py-2 pr-4 font-medium">Min / Max</th>
                <th className="py-2 pr-4 font-medium">Samples</th>
                <th className="py-2 pr-4 font-medium">Last run</th>
              </tr>
            </thead>
            <tbody>
              {summary.map((s) => (
                <tr key={s.model} className="border-b border-white/5 text-white/70">
                  <td className="py-2 pr-4 font-mono">{s.model}</td>
                  <td className="py-2 pr-4 font-mono tabular-nums">{s.avgTokensPerSecond}</td>
                  <td className="py-2 pr-4 font-mono tabular-nums text-white/45">
                    {s.minTokensPerSecond} / {s.maxTokensPerSecond}
                  </td>
                  <td className="py-2 pr-4 tabular-nums text-white/45">
                    {s.samples} ({s.chatSamples} chat, {s.manualSamples} manual)
                  </td>
                  <td className="py-2 pr-4 text-white/45">{formatDate(s.lastRunAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
