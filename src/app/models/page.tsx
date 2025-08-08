'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import { usePullLogStore, PullStructuredEvent } from '@/store/pull-log';
import { useToastStore } from '@/store/toast';

interface OllamaModelTag {
  name: string; // e.g. "llama3:latest"
  model: string; // base model
  digest?: string;
  size?: number; // bytes
  modified_at?: string;
}

interface TagsResponse {
  models: OllamaModelTag[];
}

async function fetchModels(): Promise<TagsResponse> {
  const res = await fetch('/api/models', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load models');
  return res.json();
}

function formatSize(bytes?: number) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let val = bytes;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(1)} ${units[i]}`;
}

export default function ModelsPage() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['ollama-model-tags'],
    queryFn: fetchModels,
    refetchOnWindowFocus: false,
  });

  const pushToast = useToastStore((s) => s.push);
  const addPullEvent = usePullLogStore((s) => s.add);
  const clearPullEvents = usePullLogStore((s) => s.clear);
  const pullEvents = usePullLogStore((s) => s.events);

  const deleteMutation = useMutation({
    mutationFn: async (model: string) => {
      const res = await fetch('/api/models/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.ok) throw new Error('Delete failed');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ollama-model-tags'] });
      pushToast({ type: 'success', message: 'Modell entfernt.' });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Delete fehlgeschlagen';
      pushToast({ type: 'error', message: msg });
    },
  });

  const pullMutation = useMutation({
    mutationFn: async (model: string) => {
      // streaming text response
      const res = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      if (!res.body) throw new Error('No stream body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        full += chunk;
        // parse NDJSON lines
        const lines = chunk.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            addPullEvent(model, obj);
          } catch {
            addPullEvent(model, { raw: line });
          }
        }
      }
      return full;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['ollama-model-tags'] });
      pushToast({ type: 'success', message: 'Pull abgeschlossen.' });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Pull fehlgeschlagen';
      pushToast({ type: 'error', message: msg });
    },
  });

  const [pullInput, setPullInput] = useState('');
  const [pullLog, setPullLog] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [host, setHost] = useState<string>('');
  const [hostInput, setHostInput] = useState('');
  const [updatingHost, setUpdatingHost] = useState(false);

  // load current host on mount
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/config/ollama-host');
        const j = await r.json();
        if (j.host) {
          setHost(j.host);
          setHostInput(j.host);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  async function submitHost(e: React.FormEvent) {
    e.preventDefault();
    const value = hostInput.trim();
    if (!value || value === host) return;
    setUpdatingHost(true);
    try {
      const res = await fetch('/api/config/ollama-host', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ host: value }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || 'Setzen fehlgeschlagen');
      setHost(j.host);
      pushToast({ type: 'success', message: 'Host aktualisiert.' });
      // refresh models after host change
      refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unbekannter Fehler';
      pushToast({ type: 'error', message: msg });
    } finally {
      setUpdatingHost(false);
    }
  }

  // derive progress from last event with percentage for the currently pulled model input
  useEffect(() => {
    if (!pullInput) return;
    const model = pullInput.trim();
    const relevant = [...pullEvents]
      .reverse()
      .find(
        (e) => e.model === model && typeof (e.data as PullStructuredEvent).percentage === 'number',
      );
    if (relevant) {
      const data: unknown = relevant.data;
      if (typeof data === 'object' && data !== null && 'percentage' in data) {
        const pct = (data as { percentage?: unknown }).percentage;
        if (typeof pct === 'number') setProgress(pct);
      }
    }
  }, [pullEvents, pullInput]);

  async function handlePullSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!pullInput.trim()) return;
    setPullLog('');
    setProgress(null);
    clearPullEvents(pullInput.trim());
    try {
      const model = pullInput.trim();
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (!res.body) throw new Error('Kein Stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setPullLog((prev: string) => prev + chunk);
        const lines = chunk.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            addPullEvent(model, obj);
            if (typeof obj.percentage === 'number') setProgress(obj.percentage);
          } catch {
            addPullEvent(model, { raw: line });
          }
        }
      }
      await queryClient.invalidateQueries({ queryKey: ['ollama-model-tags'] });
      pushToast({ type: 'success', message: 'Pull abgeschlossen.' });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPullLog((prev: string) => prev + '\nABORTIERT');
        pushToast({ type: 'info', message: 'Pull abgebrochen.' });
      } else {
        const msg = err instanceof Error ? err.message : 'Unbekannter Fehler';
        setPullLog((prev: string) => prev + '\nERROR: ' + msg);
        pushToast({ type: 'error', message: msg });
      }
    }
  }

  function abortPull() {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }

  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-6xl flex-col gap-10 px-10 py-14">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-br from-white via-white/80 to-white/40 bg-clip-text text-transparent">
          Installierte Modelle
        </h1>
        <Button onClick={() => refetch()} variant="outline" size="sm" loading={isFetching}>
          Refresh
        </Button>
      </div>
      <form
        onSubmit={submitHost}
        className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-center"
      >
        <div className="flex flex-1 flex-col gap-1">
          <label className="text-[10px] uppercase tracking-wide text-white/40">Ollama Host</label>
          <input
            value={hostInput}
            onChange={(e) => setHostInput(e.target.value)}
            className="rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            placeholder="http://localhost:11434"
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          loading={updatingHost}
          disabled={updatingHost || !hostInput.trim() || hostInput.trim() === host}
        >
          {updatingHost ? 'Speichere…' : 'Host setzen'}
        </Button>
        <div className="text-xs text-white/40 whitespace-nowrap">Aktuell: {host || '—'}</div>
      </form>
      <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col gap-4">
        <form
          onSubmit={handlePullSubmit}
          className="flex flex-col gap-3 sm:flex-row sm:items-center"
        >
          <input
            value={pullInput}
            onChange={(e) => setPullInput(e.target.value)}
            placeholder="modellname:tag (z.B. llama3:latest)"
            className="flex-1 rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
          <Button type="submit" size="sm" loading={false} disabled={!pullInput.trim()}>
            Pull
          </Button>
          {abortRef.current && (
            <Button type="button" variant="outline" size="sm" onClick={abortPull}>
              Abort
            </Button>
          )}
        </form>
        {progress !== null && (
          <div className="flex items-center gap-3">
            <div className="h-2 flex-1 overflow-hidden rounded bg-white/10">
              <div
                className="h-full bg-gradient-to-r from-indigo-500 via-purple-500 to-pink-500 transition-all"
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
            <span className="w-12 text-right text-xs tabular-nums text-white/60">{progress}%</span>
          </div>
        )}
        {pullLog && (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-3 text-xs text-white/70">
            {pullLog}
          </pre>
        )}
      </div>
      {isLoading && <div className="text-white/50 animate-pulse">Lade Modelle…</div>}
      {isError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          Fehler beim Laden: {(error as Error).message}
        </div>
      )}
      {!isLoading && !isError && data && (
        <motion.ul
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
        >
          {data.models.length === 0 && (
            <li className="col-span-full rounded-lg border border-white/10 bg-white/5 p-6 text-center text-white/50">
              Keine Modelle gefunden.
            </li>
          )}
          {data.models.map((m) => (
            <li
              key={m.name}
              className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/[0.06] p-5 backdrop-blur-sm transition hover:border-white/20 hover:bg-white/[0.08]"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-semibold text-white/90 tracking-tight">{m.name}</h2>
                  <p className="text-xs mt-1 text-white/40 font-mono">{m.model}</p>
                </div>
                {m.size && (
                  <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-medium text-white/60">
                    {formatSize(m.size)}
                  </span>
                )}
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-white/40">
                <span>{m.digest?.slice(0, 12) ?? '—'}</span>
                <span>
                  {m.modified_at
                    ? new Date(m.modified_at).toLocaleDateString(undefined, {
                        day: '2-digit',
                        month: 'short',
                        year: 'numeric',
                      })
                    : '—'}
                </span>
              </div>
              <div className="mt-4 flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={
                    pullMutation.status === 'pending' || deleteMutation.status === 'pending'
                  }
                  onClick={() => pullMutation.mutate(m.name)}
                >
                  Pull
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={deleteMutation.status === 'pending'}
                  disabled={pullMutation.status === 'pending'}
                  onClick={() => deleteMutation.mutate(m.name)}
                >
                  Delete
                </Button>
              </div>
              <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition" />
            </li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}
