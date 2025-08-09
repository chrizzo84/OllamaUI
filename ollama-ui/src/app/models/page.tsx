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

// Catalog related types and fetcher
interface CatalogVariant { tag: string; size_text?: string; size_bytes?: number; context?: string | null; input?: string | null }
interface CatalogModel { slug: string; name?: string; pulls?: number | null; pulls_text?: string | null; capabilities?: string[]; blurb?: string | null; description?: string | null; tags_count?: number | null; variants?: CatalogVariant[] }
interface CatalogResponse { scraped_at: string; total: number; count: number; models: CatalogModel[] }
async function fetchCatalog(query: string, limit: number): Promise<CatalogResponse> {
  const qp = new URLSearchParams();
  if (query) qp.set('q', query);
  if (limit) qp.set('limit', String(limit));
  const res = await fetch(`/api/models/catalog?${qp.toString()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load catalog');
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
      pushToast({ type: 'success', message: 'Model removed.' });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Delete failed';
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
      pushToast({ type: 'success', message: 'Pull finished.' });
    },
    onError: (e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Pull failed';
      pushToast({ type: 'error', message: msg });
    },
  });

  const [pullInput, setPullInput] = useState('');
  const [pullLog, setPullLog] = useState('');
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [currentPullModel, setCurrentPullModel] = useState<string | null>(null);
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
      if (!res.ok) throw new Error(j.error || 'Update failed');
      setHost(j.host);
      pushToast({ type: 'success', message: 'Host updated.' });
      // refresh models after host change
      refetch();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
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

  // Extracted pull start logic so we can trigger from catalog cards
  async function startPull(model: string) {
    if (!model) return;
    setCurrentPullModel(model);
    setPullInput(model);
    setPullLog('');
    setProgress(null);
    clearPullEvents(model);
    try {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const res = await fetch('/api/models/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
        signal: controller.signal,
      });
      if (!res.body) throw new Error('No stream');
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
      pushToast({ type: 'success', message: 'Pull finished.' });
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setPullLog((prev: string) => prev + '\nABORTED');
        pushToast({ type: 'info', message: 'Pull aborted.' });
      } else {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        setPullLog((prev: string) => prev + '\nERROR: ' + msg);
        pushToast({ type: 'error', message: msg });
      }
    } finally {
      abortRef.current = null;
      setCurrentPullModel(null);
    }
  }
  async function handlePullSubmit(e: React.FormEvent) { e.preventDefault(); if (pullInput.trim()) await startPull(pullInput.trim()); }
  function abortPull() { if (abortRef.current) abortRef.current.abort(); }

  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogLimit, setCatalogLimit] = useState(60);
  const { data: catalog, isLoading: catalogLoading, isError: catalogIsError, error: catalogError, refetch: refetchCatalog, isFetching: catalogFetching } = useQuery({
    queryKey: ['ollama-catalog', catalogSearch, catalogLimit],
    queryFn: () => fetchCatalog(catalogSearch, catalogLimit),
    refetchOnWindowFocus: false,
  });

  const isStreamingPull = !!abortRef.current; // active streaming pull (catalog variant)
  const anyPullActive = isStreamingPull || pullMutation.status === 'pending';
  const [expandedVariants, setExpandedVariants] = useState<Record<string, boolean>>({});
  function toggleVariants(slug: string) {
    setExpandedVariants(prev => ({ ...prev, [slug]: !prev[slug] }));
  }

  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-6xl flex-col gap-10 px-10 py-14">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-4xl font-bold tracking-tight bg-gradient-to-br from-white via-white/80 to-white/40 bg-clip-text text-transparent">
          Installed Models
        </h1>
        <Button onClick={() => refetch()} variant="outline" size="sm" loading={isFetching} title="Refresh installed models">
          Refresh
        </Button>
        <div className="ml-auto flex items-center gap-2 text-xs text-white/40">
          {/* Removed catalog snapshot from installed models header */}
        </div>
      </div>
      <form
        onSubmit={submitHost}
        className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 p-4 sm:flex-row sm:items-end"
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
          className="sm:self-end"
          title="Update Ollama host"
        >
          {updatingHost ? 'Saving…' : 'Set host'}
        </Button>
        <div className="text-xs text-white/40 whitespace-nowrap sm:self-end pb-0 sm:pb-[2px]">
          Current: {host || '—'}
        </div>
      </form>
      {/* Installed models list section (restored) */}
      {isLoading && <div className="text-white/50 animate-pulse">Loading models…</div>}
      {isError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          Error loading: {(error as Error).message}
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
              No models found.
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
                  variant="primary"
                  size="sm"
                  disabled={anyPullActive || deleteMutation.status === 'pending'}
                  onClick={() => pullMutation.mutate(m.name)}
                  title={anyPullActive ? 'A pull is already in progress' : `Pull installed model ${m.name}`}
                >
                  Pull
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  loading={deleteMutation.status === 'pending'}
                  disabled={pullMutation.status === 'pending'}
                  onClick={() => deleteMutation.mutate(m.name)}
                  title={`Delete model ${m.name}`}
                >
                  Delete
                </Button>
              </div>
              <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition" />
            </li>
          ))}
        </motion.ul>
      )}
      {/* Catalog Section */}
      <div className="mt-10 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4 w-full">
          <h2 className="text-2xl font-bold tracking-tight bg-gradient-to-br from-white via-white/80 to-white/40 bg-clip-text text-transparent flex-1">Model Catalog (available variants)</h2>
          <div className="flex items-center gap-2 text-xs text-white/40">
            <span>Catalog snapshot:</span>
            {catalogLoading ? <span className="animate-pulse">loading…</span> : catalog?.scraped_at ? <time>{new Date(catalog.scraped_at).toLocaleString()}</time> : '—'}
            <Button onClick={() => refetchCatalog()} variant="outline" size="sm" loading={catalogFetching} className="ml-2" title="Reload catalog data">Refresh Catalog</Button>
          </div>
        </div>
        {/* Search & limit controls row */}
        <div className="flex flex-col sm:flex-row gap-3 items-stretch w-full">
          <input
            value={catalogSearch}
            onChange={(e) => setCatalogSearch(e.target.value)}
            placeholder="Search models (slug, name, capability)"
            className="flex-1 rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
          {/* Limit control moved next to summary */}
        </div>
        {/* Pull Control relocated into catalog section */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-4">
          <form onSubmit={handlePullSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <input
              value={pullInput}
              onChange={(e) => setPullInput(e.target.value)}
              placeholder="model:tag (e.g. llama3.1:8b)"
              className="flex-1 rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            />
            <Button type="submit" size="sm" disabled={!pullInput.trim() || anyPullActive} title={pullInput.trim() ? (anyPullActive ? 'A pull is already in progress' : `Pull ${pullInput.trim()}`) : 'Enter model:tag to pull'}>Pull</Button>
            {abortRef.current && (
              <Button type="button" variant="outline" size="sm" onClick={abortPull} title="Abort current pull">Abort</Button>
            )}
          </form>
          {progress !== null && (
            <div className="flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded bg-white/10">
                <div className="h-full bg-gradient-to-r from-slate-500 via-slate-600 to-blue-900 transition-all" style={{ width: `${Math.min(progress, 100)}%` }} />
              </div>
              <span className="w-12 text-right text-xs tabular-nums text-white/60">{progress}%</span>
            </div>
          )}
          {pullLog && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-3 text-xs text-white/70">{pullLog}</pre>
          )}
        </div>
        {catalogLoading && <div className="text-white/50 animate-pulse">Catalog loading…</div>}
        {catalogIsError && <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">Error loading catalog: {(catalogError as Error).message}</div>}
        {catalog && (
          <div className="flex items-center flex-wrap gap-4 text-xs text-white/40">
            <div className="flex items-center gap-2">
              <label className="text-[10px] uppercase tracking-wide text-white/40">Limit</label>
              <select
                value={catalogLimit}
                onChange={(e) => setCatalogLimit(Number(e.target.value))}
                className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-xs text-white focus:outline-none"
              >
                {[30,60,120,240,0].map(n => <option key={n} value={n}>{n===0 ? 'All' : n}</option>)}
              </select>
            </div>
            <div>Showing {catalog.count} of {catalog.total} models</div>
          </div>
        )}
        {catalog && catalog.models.length === 0 && !catalogLoading && <div className="text-white/40 text-sm">No results.</div>}
        {catalog && catalog.models.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {catalog.models.map(cm => (
              <div key={cm.slug} className="rounded-xl border border-white/10 bg-white/[0.04] p-5 flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-white/90 tracking-tight">{cm.slug}</h3>
                    {cm.capabilities && cm.capabilities.length>0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {cm.capabilities.slice(0,6).map(c => <span key={c} className="rounded bg-indigo-500/20 px-2 py-[2px] text-[10px] uppercase tracking-wide text-indigo-200/80">{c}</span>)}
                      </div>
                    )}
                  </div>
                  {typeof cm.pulls === 'number' && <span className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-medium text-white/60" title={cm.pulls_text || String(cm.pulls)}>{(cm.pulls/1_000_000).toFixed(1)}M</span>}
                </div>
                {cm.blurb && <p className="text-xs text-white/50 line-clamp-3">{cm.blurb}</p>}
                {cm.variants && cm.variants.length>0 && (
                  <div className="flex flex-col gap-2 max-h-52 overflow-auto pr-1 py-2">
                    {(expandedVariants[cm.slug] ? cm.variants : cm.variants.slice(0,12)).map(v => (
                      <div key={v.tag} className="flex items-center gap-2 text-[11px] text-white/60">
                        <code className="flex-1 truncate font-mono text-white/70" title={v.tag}>{v.tag}</code>
                        {v.size_text && <span className="text-white/40" title={v.size_bytes ? formatSize(v.size_bytes) : v.size_text}>{v.size_text}</span>}
                        <Button variant="primary" size="sm" disabled={anyPullActive} onClick={()=>startPull(v.tag)} title={anyPullActive ? 'A pull is already in progress' : `Pull variant ${v.tag}`}>
                          {currentPullModel === v.tag && isStreamingPull ? 'Pulling…' : 'Pull'}
                        </Button>
                      </div>
                    ))}
                    {cm.variants.length>12 && (
                      <div className="pt-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[11px] px-2"
                          onClick={()=>toggleVariants(cm.slug)}
                          title={expandedVariants[cm.slug] ? 'Collapse variants' : 'Show all variants'}
                        >
                          {expandedVariants[cm.slug] ? 'Show less' : `Show all (${cm.variants.length})`}
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
