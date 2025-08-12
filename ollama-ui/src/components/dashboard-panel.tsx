'use client';
import React, { useEffect, useState } from 'react';
import { DashboardCharts } from './dashboard-charts';
import { NewsViewer } from './news-viewer';

interface ModelInfo {
  name: string;
  size: number; // bytes
  updatedAt?: string;
}

interface Stats {
  count: number;
  totalSize: number;
  largest: ModelInfo | null;
  averageSize: number;
  models: ModelInfo[];
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function DashboardPanel({ newsContent }: { newsContent: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchStats() {
      setLoading(true);
      setError(null);
      try {
        // Fetch models from API (depends on active host)
        const res = await fetch('/api/models');
        if (!res.ok) throw new Error('Failed to fetch models');
        const data = await res.json();
        // Assume data.models: { name, size, updatedAt }
        const models: ModelInfo[] = Array.isArray(data.models) ? data.models : [];
        const count = models.length;
        const totalSize = models.reduce((sum, m) => sum + (m.size || 0), 0);
        const largest = models.reduce(
          (max, m) => (m.size > (max?.size || 0) ? m : max),
          null as ModelInfo | null,
        );
        const averageSize = count > 0 ? totalSize / count : 0;
        setStats({ count, totalSize, largest, averageSize, models });
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    }
    fetchStats();
    // Listen for host change events to refresh
    function onHostChange() {
      fetchStats();
    }
    window.addEventListener('active-host-changed', onHostChange as EventListener);
    return () => window.removeEventListener('active-host-changed', onHostChange as EventListener);
  }, []);

  if (loading) return <div>Loading…</div>;
  if (error) return <div className="text-red-400">Error: {error}</div>;
  if (!stats) return <div>No data available.</div>;

  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-8">
      <div className="rounded-lg bg-white/5 border border-white/10 p-6 flex flex-col gap-2">
        <h2 className="text-lg font-semibold mb-2">Model Summary</h2>
        <div>
          <strong>Total Models:</strong> {stats.count}
        </div>
        <div>
          <strong>Total Size:</strong> {formatBytes(stats.totalSize)}
        </div>
        <div>
          <strong>Average Size:</strong> {formatBytes(stats.averageSize)}
        </div>
        {stats.largest && (
          <div>
            <strong>Largest Model:</strong> {stats.largest.name} ({formatBytes(stats.largest.size)})
          </div>
        )}
      </div>
      <div className="rounded-lg bg-white/5 border border-white/10 p-6 flex flex-col gap-2">
        <h2 className="text-lg font-semibold mb-2">Models Breakdown</h2>
        <ul className="max-h-64 overflow-auto text-sm">
          {stats.models.map((m) => (
            <li
              key={m.name}
              className="flex justify-between py-1 border-b border-white/5 last:border-none"
            >
              <span className="font-mono">{m.name}</span>
              <span>{formatBytes(m.size)}</span>
            </li>
          ))}
        </ul>
      </div>
      <div className="md:col-span-2 rounded-lg bg-white/5 border border-white/10 p-6 mt-2">
        <h2 className="text-lg font-semibold mb-2">Visualizations</h2>
        <DashboardCharts models={stats.models} />
      </div>
      <div className="md:col-span-2 rounded-lg bg-white/5 border border-white/10 p-6 mt-2">
        <h2 className="text-lg font-semibold mb-2">News / Release Notes</h2>
        <NewsViewer content={newsContent} />
      </div>
    </section>
  );
}
