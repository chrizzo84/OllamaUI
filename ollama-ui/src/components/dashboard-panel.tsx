'use client';
import React, { useEffect, useState } from 'react';
import { Boxes, Database, Scale, Trophy, BarChart3, Newspaper, ListTree } from 'lucide-react';
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

  if (loading) return <div className="text-white/50 animate-pulse text-sm">Loading…</div>;
  if (error) return <div className="text-red-400 text-sm">Error: {error}</div>;
  if (!stats) return <div className="text-white/50 text-sm">No data available.</div>;

  const stat = [
    { label: 'Total models', value: String(stats.count), icon: Boxes },
    { label: 'Total size', value: formatBytes(stats.totalSize), icon: Database },
    { label: 'Average size', value: formatBytes(stats.averageSize), icon: Scale },
  ];

  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-6 stagger-children">
      <div className="glass-card glass-card--hover p-6 flex flex-col gap-4">
        <span className="section-label">
          <Boxes />
          Model summary
        </span>
        <div className="grid grid-cols-3 gap-3">
          {stat.map((s) => {
            const Icon = s.icon;
            return (
              <div
                key={s.label}
                className="relative overflow-hidden rounded-xl border border-white/[0.07] bg-black/25 p-3.5"
              >
                <Icon className="absolute -right-2 -bottom-2 h-12 w-12 text-[rgb(var(--accent-glow)/0.1)]" />
                <div className="text-xl font-semibold tabular-nums text-white/90 truncate">
                  {s.value}
                </div>
                <div className="text-[10px] uppercase tracking-wide text-white/35 mt-1">
                  {s.label}
                </div>
              </div>
            );
          })}
        </div>
        {stats.largest && (
          <div className="cap-pill border-[rgb(var(--accent-glow)/0.3)] bg-[rgb(var(--accent-glow)/0.1)] text-white/70 self-start">
            <Trophy className="h-3 w-3 text-[rgb(var(--accent-glow)/0.9)]" />
            largest: {stats.largest.name} · {formatBytes(stats.largest.size)}
          </div>
        )}
      </div>
      <div className="glass-card glass-card--hover p-6 flex flex-col gap-3">
        <span className="section-label">
          <ListTree />
          Models breakdown
        </span>
        <ul className="max-h-64 overflow-auto text-sm flex flex-col gap-0.5">
          {stats.models.map((m) => (
            <li
              key={m.name}
              className="flex justify-between items-center py-1.5 px-2 rounded-lg hover:bg-white/5 transition"
            >
              <span className="font-mono text-xs text-white/70 truncate">{m.name}</span>
              <span className="font-mono text-xs text-white/40 tabular-nums shrink-0 ml-2">
                {formatBytes(m.size)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="md:col-span-2 glass-card p-6 flex flex-col gap-3">
        <span className="section-label">
          <BarChart3 />
          Visualizations
        </span>
        <DashboardCharts models={stats.models} />
      </div>
      <div className="md:col-span-2 glass-card p-6 flex flex-col gap-3">
        <span className="section-label">
          <Newspaper />
          News / release notes
        </span>
        <NewsViewer content={newsContent} />
      </div>
    </section>
  );
}
