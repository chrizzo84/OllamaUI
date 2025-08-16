'use client';
import React, { useEffect, useState } from 'react';

interface ModelInfo {
  name: string;
  size: number;
  updatedAt?: string;
}

export function ChatModelList() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshIdx, setRefreshIdx] = useState(0);

  useEffect(() => {
    async function fetchModels(showLoading = true) {
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/ps');
        if (!res.ok) throw new Error('Failed to fetch loaded models');
        const data = await res.json();
        // /api/ps returns array of objects with model details
        type LoadedModel = { name?: string; model?: string; size?: number };
        let loaded: LoadedModel[] = [];
        if (Array.isArray(data.models)) loaded = data.models;
        else if (Array.isArray(data.ps)) loaded = data.ps;
        setModels(
          loaded.map((obj) => ({
            name: obj.name || obj.model || String(obj),
            size: obj.size || 0,
          })),
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (showLoading) setLoading(false);
      }
    }
    fetchModels(true); // initial load shows loading
    const interval = setInterval(() => fetchModels(false), 10000); // auto-refresh, no loading
    function onHostChange() {
      fetchModels(true);
    }
    window.addEventListener('active-host-changed', onHostChange as EventListener);
    return () => {
      window.removeEventListener('active-host-changed', onHostChange as EventListener);
      clearInterval(interval);
    };
  }, [refreshIdx]);

  if (loading) return <div className="text-xs text-white/40 mb-2">Loading models…</div>;
  if (error) return <div className="text-xs text-red-400 mb-2">Error: {error}</div>;
  if (!models.length)
    return (
      <div className="mb-4 flex items-center gap-2">
        <span className="text-xs font-semibold text-white/60">
          Models currently loaded in Ollama:
        </span>
        <button
          type="button"
          className="ml-2 px-2 py-1 rounded border border-white/15 bg-white/10 text-white/70 hover:text-white hover:border-white/40 hover:bg-white/15 text-xs"
          title="Refresh models"
          onClick={() => setRefreshIdx((i) => i + 1)}
        >
          ↻
        </button>
        <span className="text-xs text-white/40 ml-2">No models loaded.</span>
      </div>
    );

  return (
    <div className="mb-4 flex items-center gap-2">
      <span className="text-xs font-semibold text-white/60">
        Models currently loaded in Ollama:
      </span>
      <button
        type="button"
        className="ml-2 px-2 py-1 rounded border border-white/15 bg-white/10 text-white/70 hover:text-white hover:border-white/40 hover:bg-white/15 text-xs"
        title="Refresh models"
        onClick={() => setRefreshIdx((i) => i + 1)}
      >
        ↻
      </button>
      <ul className="flex flex-wrap gap-2 ml-2">
        {models.map((m) => (
          <li
            key={m.name}
            className="px-2 py-1 rounded bg-indigo-500/20 text-indigo-200 text-xs font-mono border border-indigo-400/30"
          >
            {m.name}
          </li>
        ))}
      </ul>
    </div>
  );
}
