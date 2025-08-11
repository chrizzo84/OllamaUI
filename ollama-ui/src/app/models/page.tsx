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
interface CatalogVariant {
  tag: string;
  size_text?: string;
  size_bytes?: number;
  context?: string | null;
  input?: string | null;
}
interface CatalogModel {
  slug: string;
  name?: string;
  pulls?: number | null;
  pulls_text?: string | null;
  capabilities?: string[];
  blurb?: string | null;
  description?: string | null;
  tags_count?: number | null;
  variants?: CatalogVariant[];
}
interface CatalogResponse {
  scraped_at: string;
  total?: number; // total from remote if provided
  original_total?: number; // normalized original total we derive (always filled)
  count: number; // count after filtering/limit
  models: CatalogModel[];
}
async function fetchCatalog(
  query: string,
  limit: number,
  caps: string[],
): Promise<CatalogResponse> {
  const url =
    'https://raw.githubusercontent.com/chrizzo84/OllamaScraper/refs/heads/main/out/ollama_models.json';
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load catalog from remote');
  const raw = await res.json();
  const baseModels: CatalogModel[] = raw.models || raw.data || [];
  const originalTotal = raw.total || baseModels.length;
  let models = baseModels;
  if (query) {
    const q = query.toLowerCase();
    models = models.filter(
      (m) =>
        m.slug.toLowerCase().includes(q) ||
        (m.name && m.name.toLowerCase().includes(q)) ||
        (m.capabilities && m.capabilities.some((c) => c.toLowerCase().includes(q))),
    );
  }
  if (caps.length) {
    const wanted = caps.map((c) => c.toLowerCase());
    models = models.filter(
      (m) =>
        m.capabilities && wanted.every((w) => m.capabilities!.some((c) => c.toLowerCase() === w)),
    );
  }
  if (limit && limit > 0) {
    models = models.slice(0, limit);
  }
  return {
    scraped_at: raw.scraped_at || raw.generated_at || new Date().toISOString(),
    total: originalTotal,
    original_total: originalTotal,
    count: models.length,
    models,
  };
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
        // (Removed stray misplaced code from previous patch)
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
  const [activeHost, setActiveHost] = useState<string | null>(null);
  // Multi-host management
  interface HostRowUI {
    id: string;
    url: string;
    label?: string | null;
    active: number;
  }
  const [hosts, setHosts] = useState<HostRowUI[]>([]);
  const [hostLabel, setHostLabel] = useState('');
  const [loadingHosts, setLoadingHosts] = useState(false);
  const [hostError, setHostError] = useState<string | null>(null);
  const [editingHostId, setEditingHostId] = useState<string | null>(null);
  const [editUrl, setEditUrl] = useState('');
  const [editLabel, setEditLabel] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [editUrlForAdd, setEditUrlForAdd] = useState('');
  const [showAddHost, setShowAddHost] = useState(false);
  function closeAddHost() {
    setShowAddHost(false);
    setEditUrlForAdd('');
    setHostLabel('');
    setHostError(null);
  }
  const [testingHost, setTestingHost] = useState(false);
  const [testResult, setTestResult] = useState<null | {
    ok: boolean;
    message?: string;
    error?: string;
    latency?: number;
  }>(null);
  async function testHostConnectivity() {
    setTestResult(null);
    const url = editUrlForAdd.trim();
    const err = validateHostLocal(url);
    setHostError(err);
    if (!url || err) return;
    setTestingHost(true);
    try {
      const res = await fetch('/api/hosts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.ok && j.ok) {
        setTestResult({ ok: true, message: j.message, latency: j.latency });
      } else {
        setTestResult({ ok: false, error: j.error || 'Test failed' });
      }
    } catch (e: unknown) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : 'Network error' });
    } finally {
      setTestingHost(false);
    }
  }
  function validateHostLocal(raw: string): string | null {
    const v = raw.trim();
    if (!v) return null; // empty = neutral
    try {
      const u = new URL(v);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Must start with http/https';
      return null;
    } catch {
      return 'Invalid URL';
    }
  }
  async function loadHosts() {
    try {
      setLoadingHosts(true);
      const r = await fetch('/api/hosts');
      if (!r.ok) throw new Error('Failed to load hosts');
      const text = await r.text();
      interface HostsApiRow {
        id: string;
        url: string;
        label?: string | null;
        active: number;
      }
      interface HostsApiResponse {
        hosts?: HostsApiRow[];
        active?: string | null;
      }
      let j: HostsApiResponse;
      try {
        j = JSON.parse(text) as HostsApiResponse;
      } catch {
        throw new Error('Invalid JSON from /api/hosts');
      }
      if (j && Array.isArray(j.hosts)) {
        setHosts(j.hosts.map((h) => ({ id: h.id, url: h.url, label: h.label, active: h.active })));
        const active = j.hosts.find((hh) => !!hh.active);
        setActiveHost(active ? active.url : null);
      }
    } finally {
      setLoadingHosts(false);
    }
  }
  useEffect(() => {
    loadHosts();
  }, []);
  async function addNewHost(e: React.FormEvent) {
    e.preventDefault();
    const url = editUrlForAdd.trim();
    const err = validateHostLocal(url);
    setHostError(err);
    if (!url || err) return;
    const body: { url: string; label?: string } = { url };
    if (hostLabel.trim()) body.label = hostLabel.trim();
    const res = await fetch('/api/hosts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      setHostLabel('');
      setEditUrlForAdd('');
      setHostError(null);
      await loadHosts();
    }
  }
  async function activate(id: string) {
    const res = await fetch('/api/hosts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    if (res.ok) {
      await loadHosts();
      // auto refresh installed models when host changes
      queryClient.invalidateQueries({ queryKey: ['ollama-model-tags'] });
    }
  }
  async function removeHost(id: string) {
    const u = new URL('/api/hosts', window.location.origin);
    u.searchParams.set('id', id);
    const res = await fetch(u.toString(), { method: 'DELETE' });
    if (res.ok) await loadHosts();
  }
  async function saveEditHost(e: React.FormEvent) {
    e.preventDefault();
    if (!editingHostId) return;
    const urlTrim = editUrl.trim();
    if (!urlTrim) {
      setEditError('URL required');
      return;
    }
    const ve = validateHostLocal(urlTrim);
    setEditError(ve);
    if (ve) return;
    const payload: { id: string; action: 'update'; url: string; label?: string } = {
      id: editingHostId,
      action: 'update',
      url: urlTrim,
    };
    if (editLabel.trim()) payload.label = editLabel.trim();
    else payload.label = '';
    const res = await fetch('/api/hosts', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      setEditingHostId(null);
      setEditUrl('');
      setEditLabel('');
      setEditError(null);
      await loadHosts();
    } else {
      try {
        const j = await res.json();
        setEditError(j.error || 'Update failed');
      } catch {
        setEditError('Update failed');
      }
    }
  }
  function startEditHost(h: HostRowUI) {
    setEditingHostId(h.id);
    setEditUrl(h.url);
    setEditLabel(h.label || '');
    setEditError(null);
  }
  function cancelEditHost() {
    setEditingHostId(null);
    setEditUrl('');
    setEditLabel('');
    setEditError(null);
  }

  // Legacy host input removed; rely solely on saved hosts list

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
  async function handlePullSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pullInput.trim()) await startPull(pullInput.trim());
  }
  function abortPull() {
    if (abortRef.current) abortRef.current.abort();
  }

  const [catalogSearch, setCatalogSearch] = useState('');
  const CAPABILITY_FILTERS = ['Embedding', 'Vision', 'Tools', 'Thinking'] as const;
  const [selectedCaps, setSelectedCaps] = useState<string[]>([]);
  function toggleCap(cap: string) {
    setSelectedCaps((prev) =>
      prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap],
    );
  }
  const [catalogLimit, setCatalogLimit] = useState(60);
  const {
    data: catalog,
    isLoading: catalogLoading,
    isError: catalogIsError,
    error: catalogError,
    refetch: refetchCatalog,
    isFetching: catalogFetching,
  } = useQuery({
    queryKey: ['ollama-catalog', catalogSearch, catalogLimit, selectedCaps.sort().join(',')],
    queryFn: () => fetchCatalog(catalogSearch, catalogLimit, selectedCaps),
    refetchOnWindowFocus: false,
  });

  const isStreamingPull = !!abortRef.current; // active streaming pull (catalog variant)
  const anyPullActive = isStreamingPull || pullMutation.status === 'pending';
  const [expandedVariants, setExpandedVariants] = useState<Record<string, boolean>>({});
  function toggleVariants(slug: string) {
    setExpandedVariants((prev) => ({ ...prev, [slug]: !prev[slug] }));
  }

  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-6xl flex-col gap-10 px-10 py-14">
      <div className="flex flex-wrap items-center gap-4">
        <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-br from-white via-white/80 to-white/40 bg-clip-text text-transparent">
          Installed Models
        </h1>
        <Button
          onClick={() => refetch()}
          variant="outline"
          size="sm"
          loading={isFetching}
          title="Refresh installed models"
        >
          Refresh
        </Button>
        <div className="ml-auto flex items-center gap-2 text-xs text-white/40">
          {/* Removed catalog snapshot from installed models header */}
        </div>
      </div>
      <div className="flex flex-col gap-6">
        {/* Add Host modal removed from inline flow; now integrated into Saved Hosts section */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 relative">
          <div className="flex items-center justify-between mb-3 gap-2">
            <h2 className="text-sm font-semibold text-white/70">Saved Hosts</h2>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowAddHost(true);
                  setTimeout(() => {
                    const el = document.getElementById('add-host-url');
                    el?.focus();
                  }, 30);
                }}
              >
                Add Host
              </Button>
              <Button variant="ghost" size="sm" onClick={loadHosts} loading={loadingHosts}>
                Reload
              </Button>
            </div>
          </div>
          {hosts.length === 0 && (
            <div className="text-xs text-white/40">No hosts saved yet. Add one above.</div>
          )}
          <ul className="flex flex-col gap-2 max-h-52 overflow-auto pr-1">
            {hosts.map((h) => (
              <li
                key={h.id}
                className={`group flex items-center gap-3 rounded-md border px-3 py-2 text-xs transition ${
                  h.active
                    ? 'border-indigo-400/50 bg-indigo-500/10'
                    : 'border-white/10 bg-white/5 hover:border-white/25'
                }`}
              >
                {editingHostId === h.id ? (
                  <form onSubmit={saveEditHost} className="flex flex-1 items-start gap-2">
                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                      <input
                        value={editUrl}
                        onChange={(e) => {
                          setEditUrl(e.target.value);
                          setEditError(validateHostLocal(e.target.value));
                        }}
                        className={`w-full rounded border px-2 py-1 text-[11px] font-mono bg-white/10 ${editError ? 'border-red-500/60' : 'border-white/15'}`}
                        placeholder="http://host:11434"
                      />
                      <input
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        className="w-full rounded border px-2 py-1 text-[10px] bg-white/5 border-white/15"
                        placeholder="Label"
                      />
                      {editError && <div className="text-[10px] text-red-300">{editError}</div>}
                    </div>
                    <div className="flex flex-col gap-1">
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] px-2"
                      >
                        Save
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 text-[10px] px-2"
                        onClick={cancelEditHost}
                      >
                        Cancel
                      </Button>
                    </div>
                  </form>
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-mono text-white/70" title={h.url}>
                        {h.url}
                      </div>
                      {h.label && (
                        <div className="text-[10px] text-white/40 truncate" title={h.label}>
                          {h.label}
                        </div>
                      )}
                    </div>
                    {h.active ? (
                      <span className="px-2 py-0.5 rounded bg-indigo-500/30 text-[10px] text-indigo-100">
                        Active
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px]"
                        onClick={() => activate(h.id)}
                        title="Activate host"
                      >
                        Use
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] text-indigo-200 hover:text-indigo-100"
                      onClick={() => startEditHost(h)}
                      title="Edit host"
                    >
                      ✎
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 text-[10px] text-red-300 hover:text-red-200"
                      onClick={() => removeHost(h.id)}
                      title="Delete host"
                    >
                      ✕
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
      {/* Installed models list section (restored) */}
      {!activeHost && (
        <div className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-200">
          No active host configured. Please add a host above and activate it.
        </div>
      )}
      {isLoading && activeHost && (
        <div className="text-white/50 animate-pulse">Loading models…</div>
      )}
      {isError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
          Error loading: {(error as Error).message}
        </div>
      )}
      {!isLoading && !isError && data && activeHost && (
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
                  disabled={anyPullActive}
                  onClick={() => startPull(m.name)}
                  title={
                    anyPullActive
                      ? 'A pull is already in progress'
                      : `Pull installed model ${m.name}`
                  }
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
        {/* Catalog Header */}
        <div className="flex flex-wrap items-center gap-4 w-full">
          <h2 className="text-2xl font-bold tracking-tight bg-gradient-to-br from-white via-white/80 to-white/40 bg-clip-text text-transparent">
            Model Catalog (available variants)
          </h2>
          <Button
            onClick={() => refetchCatalog()}
            variant="outline"
            size="sm"
            loading={catalogFetching}
            title="Reload catalog data"
          >
            Refresh
          </Button>
          <div className="ml-auto flex items-center gap-2 text-xs text-white/40">
            <span>Snapshot:</span>
            {catalogLoading ? (
              <span className="animate-pulse">loading…</span>
            ) : catalog?.scraped_at ? (
              <time>{new Date(catalog.scraped_at).toLocaleString()}</time>
            ) : (
              '—'
            )}
          </div>
        </div>
        {/* Pullbox directly below header */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-4">
          <form
            onSubmit={handlePullSubmit}
            className="flex flex-col gap-3 sm:flex-row sm:items-center"
          >
            <input
              value={pullInput}
              onChange={(e) => setPullInput(e.target.value)}
              placeholder="model:tag (e.g. llama3.1:8b)"
              className="flex-1 rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!pullInput.trim() || anyPullActive}
              title={
                pullInput.trim()
                  ? anyPullActive
                    ? 'A pull is already in progress'
                    : `Pull ${pullInput.trim()}`
                  : 'Enter model:tag to pull'
              }
            >
              Pull
            </Button>
            {abortRef.current && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={abortPull}
                title="Abort current pull"
              >
                Abort
              </Button>
            )}
          </form>
          {progress !== null && (
            <div className="flex items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded bg-white/10">
                <div
                  className="h-full bg-gradient-to-r from-slate-500 via-slate-600 to-blue-900 transition-all"
                  style={{ width: `${Math.min(progress, 100)}%` }}
                />
              </div>
              <span className="w-12 text-right text-xs tabular-nums text-white/60">
                {progress}%
              </span>
            </div>
          )}
          {pullLog && (
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-3 text-xs text-white/70">
              {pullLog}
            </pre>
          )}
        </div>
        {/* Search, Limit & Capability Filters grouped */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-4 flex flex-col gap-4">
          <div className="flex flex-col sm:flex-row gap-3 items-stretch w-full">
            <div className="flex flex-1 gap-3">
              <input
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="Search models (slug, name, capability)"
                className="flex-1 rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3 w-full text-[11px] text-white/60">
            {CAPABILITY_FILTERS.map((cap) => {
              const active = selectedCaps.includes(cap);
              return (
                <button
                  key={cap}
                  type="button"
                  onClick={() => toggleCap(cap)}
                  className={`px-3 py-1 rounded-md border text-xs transition focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${
                    active
                      ? 'bg-indigo-500/30 border-indigo-400/60 text-indigo-200'
                      : 'bg-white/5 border-white/15 hover:border-white/30'
                  }`}
                  aria-pressed={active}
                  title={active ? `Remove ${cap}` : `Filter by ${cap}`}
                >
                  <span className="font-medium">{cap}</span>
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => selectedCaps.length && setSelectedCaps([])}
              disabled={!selectedCaps.length}
              className={`px-2 py-1 rounded-md border text-[10px] uppercase tracking-wide transition focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${
                selectedCaps.length
                  ? 'border-white/25 bg-white/10 text-white/60 hover:border-white/40 hover:text-white/80'
                  : 'border-white/10 bg-white/5 text-white/25 cursor-not-allowed'
              }`}
              title={selectedCaps.length ? 'Clear capability filters' : 'No filters active'}
            >
              Clear
            </button>
            <div className="ml-auto flex items-center gap-4">
              {catalog && (
                <div className="flex items-center gap-3 text-xs">
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] uppercase tracking-wide text-white/40">
                      Limit
                    </label>
                    <select
                      value={catalogLimit}
                      onChange={(e) => setCatalogLimit(Number(e.target.value))}
                      className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-[11px] text-white focus:outline-none"
                    >
                      {[30, 60, 120, 240, 0].map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? 'All' : n}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="text-white/40 whitespace-nowrap">
                    {(() => {
                      if (!catalog) return null;
                      const total =
                        catalog.original_total ?? catalog.total ?? catalog.models.length;
                      const limitDisplay = catalogLimit === 0 ? 'All' : catalogLimit;
                      return (
                        <span>
                          Showing <span className="text-white/70 tabular-nums">{limitDisplay}</span>{' '}
                          of <span className="text-white/70 tabular-nums">{total}</span> models
                        </span>
                      );
                    })()}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
        {catalogLoading && <div className="text-white/50 animate-pulse">Catalog loading…</div>}
        {catalogIsError && (
          <div className="rounded-md border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            Error loading catalog: {(catalogError as Error).message}
          </div>
        )}
        {catalog && catalog.models.length === 0 && !catalogLoading && (
          <div className="text-white/40 text-sm">No results.</div>
        )}
        {catalog && catalog.models.length > 0 && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {catalog.models.map((cm) => (
              <div
                key={cm.slug}
                className="rounded-xl border border-white/10 bg-white/[0.04] p-5 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold text-white/90 tracking-tight">{cm.slug}</h3>
                    {cm.capabilities && cm.capabilities.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {cm.capabilities.slice(0, 6).map((c) => (
                          <span
                            key={c}
                            className="rounded bg-indigo-500/20 px-2 py-[2px] text-[10px] uppercase tracking-wide text-indigo-200/80"
                          >
                            {c}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  {typeof cm.pulls === 'number' && (
                    <span
                      className="rounded-full bg-white/10 px-2 py-1 text-[10px] font-medium text-white/60"
                      title={cm.pulls_text || String(cm.pulls)}
                    >
                      {(cm.pulls / 1_000_000).toFixed(1)}M
                    </span>
                  )}
                </div>
                {cm.blurb && <p className="text-xs text-white/50 line-clamp-3">{cm.blurb}</p>}
                {cm.variants && cm.variants.length > 0 && (
                  <div className="flex flex-col gap-2 max-h-52 overflow-auto pr-1 py-2">
                    {(expandedVariants[cm.slug] ? cm.variants : cm.variants.slice(0, 12)).map(
                      (v) => (
                        <div
                          key={v.tag}
                          className="flex items-center gap-2 text-[11px] text-white/60"
                        >
                          <code className="flex-1 truncate font-mono text-white/70" title={v.tag}>
                            {v.tag}
                          </code>
                          {v.size_text && (
                            <span
                              className="text-white/40"
                              title={v.size_bytes ? formatSize(v.size_bytes) : v.size_text}
                            >
                              {v.size_text}
                            </span>
                          )}
                          <Button
                            variant="primary"
                            size="sm"
                            disabled={anyPullActive}
                            onClick={() => startPull(v.tag)}
                            title={
                              anyPullActive
                                ? 'A pull is already in progress'
                                : `Pull variant ${v.tag}`
                            }
                          >
                            {currentPullModel === v.tag && isStreamingPull ? 'Pulling…' : 'Pull'}
                          </Button>
                        </div>
                      ),
                    )}
                    {cm.variants.length > 12 && (
                      <div className="pt-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-6 text-[11px] px-2"
                          onClick={() => toggleVariants(cm.slug)}
                          title={
                            expandedVariants[cm.slug] ? 'Collapse variants' : 'Show all variants'
                          }
                        >
                          {expandedVariants[cm.slug]
                            ? 'Show less'
                            : `Show all (${cm.variants.length})`}
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
      {/* Add Host Modal */}
      {showAddHost && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => closeAddHost()}
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-white/15 bg-zinc-900/95 p-6 shadow-2xl flex flex-col gap-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white/80">Add Ollama Host</h3>
              <button
                onClick={() => closeAddHost()}
                className="text-white/40 hover:text-white/70 text-sm"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <form
              onSubmit={(e) => {
                addNewHost(e);
                if (!hostError) closeAddHost();
              }}
              className="flex flex-col gap-4"
            >
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="add-host-url"
                  className="text-[10px] uppercase tracking-wide text-white/40"
                >
                  Host URL
                </label>
                <input
                  id="add-host-url"
                  value={editUrlForAdd}
                  onChange={(e) => {
                    setEditUrlForAdd(e.target.value);
                    setHostError(validateHostLocal(e.target.value));
                  }}
                  placeholder="http://localhost:11434"
                  className={`rounded-md border px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${hostError ? 'border-red-500/60 bg-red-500/10' : 'border-white/15 bg-white/10'}`}
                />
                {hostError && <div className="text-[11px] text-red-300">{hostError}</div>}
                <div className="flex items-center gap-3 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!editUrlForAdd.trim() || !!hostError || testingHost}
                    onClick={testHostConnectivity}
                    loading={testingHost}
                    title="Test connectivity"
                  >
                    Test
                  </Button>
                  {testResult && (
                    <div
                      className={`text-[11px] ${testResult.ok ? 'text-green-300' : 'text-red-300'} flex items-center gap-2`}
                    >
                      {testResult.ok ? (
                        <>
                          <span>{testResult.message || 'Reachable'}</span>
                          {typeof testResult.latency === 'number' && (
                            <span className="text-white/30">({testResult.latency}ms)</span>
                          )}
                        </>
                      ) : (
                        <span>{testResult.error}</span>
                      )}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <label
                  htmlFor="add-host-label"
                  className="text-[10px] uppercase tracking-wide text-white/40"
                >
                  Label (optional)
                </label>
                <input
                  id="add-host-label"
                  value={hostLabel}
                  onChange={(e) => setHostLabel(e.target.value)}
                  placeholder="Local GPU, Remote A100..."
                  className="rounded-md border border-white/15 bg-white/5 px-3 py-2 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
              <div className="flex items-center justify-end gap-3 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => closeAddHost()}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!editUrlForAdd.trim() || !!hostError}
                  title={
                    testResult && testResult.ok === false ? 'Fix host before adding' : 'Add host'
                  }
                >
                  Add Host
                </Button>
              </div>
            </form>
            <p className="text-[10px] text-white/30 leading-relaxed">
              Host will be stored locally in the app database. Make sure the Ollama service is
              reachable from the server.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
