'use client';
import { useEffect, useState } from 'react';
import { Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement);

/* Categorical palette validated for dark surfaces (CVD-safe adjacent pairs,
   >=3:1 contrast). Fixed slot order — never cycled or generated. */
const CATEGORICAL = [
  '#3987e5', // blue
  '#008300', // green
  '#d55181', // magenta
  '#c98500', // yellow
  '#199e70', // aqua
  '#d95926', // orange
  '#9085e9', // violet
  '#e66767', // red
];
const OTHER_COLOR = '#6b7280'; // neutral for the folded "Other" slice
const SURFACE = '#10131f'; // approx. glass-card surface for slice gaps
const GRID_COLOR = 'rgba(255, 255, 255, 0.06)';
const TICK_COLOR = 'rgba(255, 255, 255, 0.55)';
const MAX_SLICES = 7; // beyond this, fold into "Other"

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/** Read the active theme's accent (rgb triplet in --accent-glow), tracking theme switches. */
function useAccentColor(): string {
  const [accent, setAccent] = useState('99 102 241');
  useEffect(() => {
    function read() {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-glow').trim();
      if (v) setAccent(v);
    }
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);
  return accent;
}

const tooltipStyle = {
  backgroundColor: 'rgba(13, 16, 32, 0.95)',
  borderColor: 'rgba(255, 255, 255, 0.12)',
  borderWidth: 1,
  titleColor: 'rgba(255, 255, 255, 0.9)',
  bodyColor: 'rgba(255, 255, 255, 0.7)',
  padding: 10,
  cornerRadius: 8,
  displayColors: false,
} as const;

export function DashboardCharts({ models }: { models: { name: string; size: number }[] }) {
  const accent = useAccentColor();
  if (!models || models.length === 0) return <div>No chart data available.</div>;

  const sorted = [...models].sort((a, b) => b.size - a.size);

  // Horizontal bar: model sizes, single series -> one hue (theme accent), no legend
  const barData = {
    labels: sorted.map((m) => m.name),
    datasets: [
      {
        label: 'Size',
        data: sorted.map((m) => m.size),
        backgroundColor: `rgba(${accent.replace(/ /g, ',')}, 0.65)`,
        hoverBackgroundColor: `rgba(${accent.replace(/ /g, ',')}, 0.9)`,
        borderRadius: 4,
        borderSkipped: 'start' as const,
        barThickness: 14,
      },
    ],
  };
  const barOptions = {
    indexAxis: 'y' as const,
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: {
        ...tooltipStyle,
        callbacks: {
          label: (ctx: { raw: unknown }) => formatBytes(Number(ctx.raw)),
        },
      },
    },
    scales: {
      x: {
        grid: { color: GRID_COLOR },
        border: { display: false },
        ticks: {
          color: TICK_COLOR,
          font: { size: 10 },
          callback: (v: unknown) => formatBytes(Number(v)),
          maxTicksLimit: 6,
        },
      },
      y: {
        grid: { display: false },
        border: { display: false },
        ticks: { color: TICK_COLOR, font: { size: 10, family: 'monospace' } },
      },
    },
  };

  // Doughnut: share of disk usage. Top slices get fixed categorical slots,
  // the rest folds into a neutral "Other".
  const top = sorted.slice(0, MAX_SLICES);
  const rest = sorted.slice(MAX_SLICES);
  const restTotal = rest.reduce((sum, m) => sum + m.size, 0);
  const sliceLabels = [...top.map((m) => m.name), ...(rest.length ? ['Other'] : [])];
  const sliceValues = [...top.map((m) => m.size), ...(rest.length ? [restTotal] : [])];
  const sliceColors = [...top.map((_, i) => CATEGORICAL[i]), ...(rest.length ? [OTHER_COLOR] : [])];
  const total = sliceValues.reduce((s, v) => s + v, 0);

  const pieData = {
    labels: sliceLabels,
    datasets: [
      {
        label: 'Size share',
        data: sliceValues,
        backgroundColor: sliceColors,
        borderColor: SURFACE,
        borderWidth: 2,
        hoverOffset: 6,
      },
    ],
  };
  const pieOptions = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '62%',
    plugins: {
      legend: {
        position: 'right' as const,
        labels: {
          color: 'rgba(255, 255, 255, 0.65)',
          usePointStyle: true,
          pointStyle: 'circle',
          boxWidth: 8,
          boxHeight: 8,
          font: { size: 10, family: 'monospace' },
        },
      },
      tooltip: {
        ...tooltipStyle,
        callbacks: {
          label: (ctx: { raw: unknown; label?: string }) => {
            const v = Number(ctx.raw);
            const pct = total > 0 ? Math.round((v / total) * 100) : 0;
            return `${formatBytes(v)} · ${pct}%`;
          },
        },
      },
    },
  };

  const barHeight = Math.max(220, Math.min(420, sorted.length * 28 + 60));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4">
      <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4 flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-wide text-white/35">Model sizes</span>
        <div style={{ height: barHeight }}>
          <Bar data={barData} options={barOptions} />
        </div>
      </div>
      <div className="rounded-xl border border-white/[0.07] bg-black/25 p-4 flex flex-col gap-2">
        <span className="text-[10px] uppercase tracking-wide text-white/35">Disk usage share</span>
        <div className="flex-1 min-h-[220px]">
          <Doughnut data={pieData} options={pieOptions} />
        </div>
      </div>
    </div>
  );
}
