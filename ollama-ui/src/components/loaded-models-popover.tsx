'use client';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { isStopSupported } from '@/lib/version';

interface LoadedModel {
  name: string;
  model?: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
}

interface LoadedModelsPopoverProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

export function LoadedModelsPopover({ open, onClose, anchorRef }: LoadedModelsPopoverProps) {
  const [models, setModels] = useState<LoadedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [stopping, setStopping] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [psRes, versionRes] = await Promise.all([
        fetch('/api/ps', { cache: 'no-store' }),
        fetch('/api/version', { cache: 'no-store' }),
      ]);

      if (psRes.ok) {
        const psData = await psRes.json();
        const loaded = Array.isArray(psData.models) ? psData.models : [];
        setModels(
          loaded.map((m: LoadedModel) => ({
            name: m.name || m.model || 'Unknown',
            size: m.size,
            size_vram: m.size_vram,
            expires_at: m.expires_at,
          })),
        );
      }

      if (versionRes.ok) {
        const vData = await versionRes.json();
        setVersion(vData.version || null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      fetchData();
    }
  }, [open, fetchData]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open, onClose, anchorRef]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  const handleStop = async (modelName: string) => {
    setStopping(modelName);
    try {
      const res = await fetch('/api/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName }),
      });
      if (res.ok) {
        // Wait a moment for Ollama to unload, then refresh
        await new Promise((r) => setTimeout(r, 500));
        await fetchData();
        // Dispatch event so other components can refresh
        window.dispatchEvent(new CustomEvent('active-host-changed'));
      } else {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to stop model');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStopping(null);
    }
  };

  if (!open) return null;

  const stopSupported = version ? isStopSupported(version) : false;

  return (
    <div
      ref={popoverRef}
      className="absolute right-0 top-full mt-2 z-50 min-w-[320px] max-w-[400px] rounded-lg border border-white/15 bg-[#1a1f2e]/95 backdrop-blur-xl shadow-2xl"
      role="dialog"
      aria-label="Loaded Models"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-white/10">
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-white">Loaded Models</span>
          {version && (
            <span className="text-[10px] text-white/50 font-mono">Ollama v{version}</span>
          )}
        </div>
        <button
          type="button"
          onClick={() => fetchData()}
          className="p-1.5 rounded hover:bg-white/10 text-white/60 hover:text-white transition-colors"
          title="Refresh"
        >
          ↻
        </button>
      </div>

      {/* Content */}
      <div className="p-3 max-h-[300px] overflow-y-auto">
        {loading && (
          <div className="flex items-center justify-center py-6">
            <span className="text-white/40 text-sm animate-pulse">Loading...</span>
          </div>
        )}

        {error && <div className="text-red-400 text-xs py-2 px-1">{error}</div>}

        {!loading && !error && models.length === 0 && (
          <div className="text-center py-6">
            <span className="text-white/40 text-sm">No models currently loaded</span>
          </div>
        )}

        {!loading && !error && models.length > 0 && (
          <ul className="space-y-2">
            {models.map((model) => (
              <li
                key={model.name}
                className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg bg-white/5 border border-white/10 hover:border-white/20 transition-colors"
              >
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="text-sm font-mono text-indigo-200 truncate" title={model.name}>
                    {model.name}
                  </span>
                  {model.size && (
                    <span className="text-[10px] text-white/40">
                      {formatBytes(model.size)}
                      {model.size_vram ? ` (VRAM: ${formatBytes(model.size_vram)})` : ''}
                    </span>
                  )}
                </div>
                {stopSupported ? (
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={() => handleStop(model.name)}
                    disabled={stopping === model.name}
                    loading={stopping === model.name}
                    className="shrink-0 !h-7 !px-2.5 !text-xs"
                    title="Stop / Unload model"
                  >
                    Stop
                  </Button>
                ) : (
                  <span
                    className="text-[10px] text-yellow-400/70 shrink-0"
                    title="Requires Ollama v0.1.33+"
                  >
                    v0.1.33+
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        {!loading && !stopSupported && version && (
          <div className="mt-3 p-2 rounded bg-yellow-500/10 border border-yellow-500/20">
            <span className="text-[11px] text-yellow-200/80">
              ⚠ Stop feature requires Ollama v0.1.33 or later. Current: v{version}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Hook to fetch the count of loaded models
 */
export function useLoadedModelsCount() {
  const [count, setCount] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let aborted = false;

    async function fetchCount() {
      try {
        const res = await fetch('/api/ps', { cache: 'no-store' });
        if (!res.ok || aborted) return;
        const data = await res.json();
        const models = Array.isArray(data.models) ? data.models : [];
        if (!aborted) setCount(models.length);
      } catch {
        // ignore
      } finally {
        if (!aborted) setLoading(false);
      }
    }

    fetchCount();
    const interval = setInterval(fetchCount, 10000);

    function onHostChange() {
      fetchCount();
    }
    window.addEventListener('active-host-changed', onHostChange as EventListener);

    return () => {
      aborted = true;
      clearInterval(interval);
      window.removeEventListener('active-host-changed', onHostChange as EventListener);
    };
  }, []);

  return { count, loading };
}
