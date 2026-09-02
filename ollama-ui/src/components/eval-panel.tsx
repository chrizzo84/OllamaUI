'use client';
/*
Evaluation sets: run your own prompts across several models and score the
answers side by side.

The existing benchmark answers "which model is fastest on this hardware".
The question you actually have when picking a local model is "which one is
better at the things I do", and no fixed prompt can answer that — it needs
your prompts and your judgement. Speed is carried along on every result, so
the trade-off ("the 30B is clearly better here, but three times slower") is
visible in the same place rather than in two separate screens.
*/
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Play, Plus, Trash2, Star, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/store/toast';
import { cn } from '@/lib/utils';

interface EvalSet {
  id: string;
  name: string;
  prompts: string[];
  updated_at: number;
}

interface EvalRun {
  id: string;
  setName: string;
  models: string[];
  status: 'running' | 'done';
  created_at: number;
}

interface EvalResult {
  id: string;
  promptIndex: number;
  prompt: string;
  model: string;
  content: string;
  error: string | null;
  tokensPerSecond: number | null;
  durationMs: number | null;
  rating: number | null;
}

async function fetchInstalledModels(): Promise<string[]> {
  const r = await fetch('/api/models', { cache: 'no-store' });
  if (!r.ok) return [];
  const data = await r.json();
  const list = (data.models ?? data.items ?? []) as Array<{ name?: string }>;
  return list.map((m) => m.name).filter((n): n is string => !!n);
}

function StarRating({
  value,
  onChange,
}: {
  value: number | null;
  onChange: (rating: number | null) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          // Clicking the current rating clears it: "not judged yet" is a real
          // state and must be reachable again after a misclick.
          onClick={() => onChange(value === n ? null : n)}
          title={value === n ? 'Clear rating' : `Rate ${n} of 5`}
          className="p-0.5 transition hover:scale-110"
        >
          <Star
            className={cn(
              'h-3.5 w-3.5',
              value !== null && n <= value ? 'fill-amber-300 text-amber-300' : 'text-white/25',
            )}
          />
        </button>
      ))}
    </div>
  );
}

export function EvalPanel() {
  const pushToast = useToastStore((s) => s.push);
  const [sets, setSets] = useState<EvalSet[] | null>(null);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [results, setResults] = useState<EvalResult[]>([]);
  const [activeRun, setActiveRun] = useState<EvalRun | null>(null);
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id?: string; name: string; prompts: string } | null>(
    null,
  );
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [starting, setStarting] = useState(false);

  const { data: models = [] } = useQuery({
    queryKey: ['installed-models'],
    queryFn: fetchInstalledModels,
  });

  const loadSets = useCallback(async () => {
    const r = await fetch('/api/evals/sets', { cache: 'no-store' });
    setSets(r.ok ? (await r.json()).sets : []);
  }, []);

  const loadRuns = useCallback(async () => {
    const r = await fetch('/api/evals/runs', { cache: 'no-store' });
    if (r.ok) setRuns((await r.json()).runs ?? []);
  }, []);

  useEffect(() => {
    void loadSets();
    void loadRuns();
  }, [loadSets, loadRuns]);

  const loadRun = useCallback(async (id: string) => {
    const r = await fetch(`/api/evals/runs/${id}`, { cache: 'no-store' });
    if (!r.ok) return;
    const data = await r.json();
    setActiveRun(data.run);
    setResults(data.results ?? []);
  }, []);

  useEffect(() => {
    if (!activeRunId) return;
    void loadRun(activeRunId);
  }, [activeRunId, loadRun]);

  // While a run is in flight the matrix fills in row by row, so it is polled
  // rather than loaded once. Polling stops the moment the run reports done.
  useEffect(() => {
    if (!activeRunId || activeRun?.status !== 'running') return;
    const timer = setInterval(() => {
      void loadRun(activeRunId);
      void loadRuns();
    }, 2500);
    return () => clearInterval(timer);
  }, [activeRunId, activeRun?.status, loadRun, loadRuns]);

  async function saveSet() {
    if (!editing) return;
    const prompts = editing.prompts
      .split('\n')
      .map((p) => p.trim())
      .filter(Boolean);
    const r = await fetch('/api/evals/sets', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editing.id, name: editing.name, prompts }),
    });
    if (!r.ok) {
      const data = await r.json().catch(() => ({}));
      pushToast({ type: 'error', message: data.error || 'Could not save the set.' });
      return;
    }
    setEditing(null);
    void loadSets();
  }

  async function removeSet(id: string) {
    await fetch(`/api/evals/sets?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    void loadSets();
  }

  async function startRun(setId: string) {
    if (selectedModels.length === 0) {
      pushToast({ type: 'error', message: 'Pick at least one model to compare.' });
      return;
    }
    setStarting(true);
    try {
      const r = await fetch('/api/evals/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ setId, models: selectedModels }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        pushToast({ type: 'error', message: data.error || 'Could not start the run.' });
        return;
      }
      setActiveRunId(data.run.id);
      setActiveRun(data.run);
      setResults([]);
      void loadRuns();
    } finally {
      setStarting(false);
    }
  }

  async function rate(resultId: string, rating: number | null) {
    // Optimistic: the score is the user's own judgement, so it should land
    // instantly; a failed write is reported and reverted by the reload.
    setResults((prev) => prev.map((r) => (r.id === resultId ? { ...r, rating } : r)));
    const r = await fetch('/api/evals/results', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: resultId, rating }),
    });
    if (!r.ok) {
      pushToast({ type: 'error', message: 'Could not save the rating.' });
      if (activeRunId) void loadRun(activeRunId);
    }
  }

  // Results grouped by prompt, each holding one cell per model.
  const byPrompt = useMemo(() => {
    const map = new Map<number, { prompt: string; cells: EvalResult[] }>();
    for (const r of results) {
      const entry = map.get(r.promptIndex);
      if (entry) entry.cells.push(r);
      else map.set(r.promptIndex, { prompt: r.prompt, cells: [r] });
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [results]);

  // Average score per model across everything rated in this run — the
  // summary the whole screen exists to produce.
  const modelScores = useMemo(() => {
    const acc = new Map<string, { total: number; count: number; speed: number[] }>();
    for (const r of results) {
      const entry = acc.get(r.model) ?? { total: 0, count: 0, speed: [] };
      if (r.rating !== null) {
        entry.total += r.rating;
        entry.count += 1;
      }
      if (r.tokensPerSecond !== null) entry.speed.push(r.tokensPerSecond);
      acc.set(r.model, entry);
    }
    return [...acc.entries()]
      .map(([model, e]) => ({
        model,
        average: e.count ? e.total / e.count : null,
        rated: e.count,
        tokensPerSecond: e.speed.length
          ? Math.round((e.speed.reduce((a, b) => a + b, 0) / e.speed.length) * 10) / 10
          : null,
      }))
      .sort((a, b) => (b.average ?? -1) - (a.average ?? -1));
  }, [results]);

  const toggleModel = (m: string) =>
    setSelectedModels((prev) => (prev.includes(m) ? prev.filter((x) => x !== m) : [...prev, m]));

  const togglePrompt = (i: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-card flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white/90">Prompt sets</h2>
          {!editing && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing({ name: '', prompts: '' })}
            >
              <span className="inline-flex items-center gap-1.5">
                <Plus className="h-3.5 w-3.5" /> New set
              </span>
            </Button>
          )}
        </div>

        {editing ? (
          <div className="flex flex-col gap-3">
            <input
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="Set name, e.g. German summarization"
              className="h-9 rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-white/90 outline-none focus:border-white/30"
            />
            <textarea
              value={editing.prompts}
              onChange={(e) => setEditing({ ...editing, prompts: e.target.value })}
              placeholder={'One prompt per line.\nEach one is sent to every selected model.'}
              className="min-h-[140px] rounded-lg border border-white/10 bg-black/25 px-3 py-2 font-mono text-xs text-white/90 outline-none focus:border-white/30"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={saveSet} disabled={!editing.name.trim()}>
                Save set
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : sets === null ? (
          <p className="text-xs text-white/40">Loading…</p>
        ) : sets.length === 0 ? (
          <p className="text-xs text-white/40">
            No prompt sets yet. Create one with the questions you actually ask — that is what makes
            the comparison mean something for your work rather than for a generic benchmark.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {sets.map((set) => (
              <div
                key={set.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-white/10 bg-white/5 p-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-white/85">{set.name}</p>
                  <p className="text-[11px] text-white/40">
                    {set.prompts.length} prompt{set.prompts.length === 1 ? '' : 's'}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1.5">
                  <Button
                    size="sm"
                    onClick={() => startRun(set.id)}
                    loading={starting}
                    title={`Run against ${selectedModels.length} selected model(s)`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <Play className="h-3 w-3" /> Run
                    </span>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setEditing({ id: set.id, name: set.name, prompts: set.prompts.join('\n') })
                    }
                  >
                    Edit
                  </Button>
                  <button
                    type="button"
                    onClick={() => removeSet(set.id)}
                    title="Delete set"
                    className="rounded p-1.5 text-white/30 transition hover:bg-white/10 hover:text-red-300"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="glass-card flex flex-col gap-3 p-5">
        <h2 className="text-lg font-semibold text-white/90">Models to compare</h2>
        <p className="text-xs text-white/50">
          Every prompt runs against each of these, one at a time — sequentially, so the speed
          figures aren&apos;t distorted by models competing for the same GPU.
        </p>
        <div className="flex flex-wrap gap-2">
          {models.map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => toggleModel(m)}
              className={cn(
                'rounded-lg border px-2.5 py-1.5 font-mono text-[11px] transition',
                selectedModels.includes(m)
                  ? 'border-[rgb(var(--accent-glow)/0.5)] bg-[rgb(var(--accent-glow)/0.15)] text-white'
                  : 'border-white/10 bg-white/5 text-white/55 hover:text-white',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      </section>

      {runs.length > 0 && (
        <section className="glass-card flex flex-col gap-3 p-5">
          <h2 className="text-lg font-semibold text-white/90">Runs</h2>
          <div className="flex flex-wrap gap-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setActiveRunId(run.id)}
                className={cn(
                  'rounded-lg border px-2.5 py-1.5 text-[11px] transition',
                  activeRunId === run.id
                    ? 'border-white/30 bg-white/10 text-white'
                    : 'border-white/10 bg-white/5 text-white/55 hover:text-white',
                )}
              >
                {run.setName} · {run.models.length} models ·{' '}
                {run.status === 'running' ? (
                  <span className="text-amber-300">running…</span>
                ) : (
                  new Date(run.created_at).toLocaleString()
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      {activeRun && (
        <section className="glass-card flex flex-col gap-4 p-5">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-semibold text-white/90">{activeRun.setName}</h2>
            {activeRun.status === 'running' && (
              <span className="text-xs text-amber-300">Running — results appear as they land</span>
            )}
          </div>

          {modelScores.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[380px] text-left text-xs">
                <thead className="text-white/40">
                  <tr>
                    <th className="pb-1.5 font-medium">Model</th>
                    <th className="pb-1.5 font-medium">Avg. rating</th>
                    <th className="pb-1.5 font-medium">Rated</th>
                    <th className="pb-1.5 font-medium">Tokens/s</th>
                  </tr>
                </thead>
                <tbody className="text-white/75">
                  {modelScores.map((s) => (
                    <tr key={s.model} className="border-t border-white/5">
                      <td className="py-1.5 font-mono">{s.model}</td>
                      <td className="py-1.5">
                        {s.average === null ? (
                          <span className="text-white/30">not rated</span>
                        ) : (
                          s.average.toFixed(2)
                        )}
                      </td>
                      <td className="py-1.5 text-white/45">{s.rated}</td>
                      <td className="py-1.5">{s.tokensPerSecond ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-col gap-3">
            {byPrompt.map(([index, { prompt, cells }]) => (
              <div key={index} className="rounded-lg border border-white/10 bg-white/5">
                <button
                  type="button"
                  onClick={() => togglePrompt(index)}
                  className="flex w-full items-start gap-2 p-3 text-left"
                >
                  {expanded.has(index) ? (
                    <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
                  ) : (
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-white/40" />
                  )}
                  <span className="text-xs text-white/75">{prompt}</span>
                </button>
                {expanded.has(index) && (
                  <div className="grid gap-3 border-t border-white/5 p-3 md:grid-cols-2">
                    {cells.map((cell) => (
                      <div
                        key={cell.id}
                        className="flex flex-col gap-2 rounded border border-white/10 p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-[11px] text-white/60">
                            {cell.model}
                          </span>
                          <span className="shrink-0 text-[10px] text-white/35">
                            {cell.tokensPerSecond ? `${cell.tokensPerSecond} tok/s` : ''}
                          </span>
                        </div>
                        {cell.error ? (
                          <p className="text-[11px] text-red-300">{cell.error}</p>
                        ) : (
                          <p className="max-h-56 overflow-y-auto whitespace-pre-wrap text-[11px] text-white/80">
                            {cell.content}
                          </p>
                        )}
                        <StarRating value={cell.rating} onChange={(r) => rate(cell.id, r)} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
