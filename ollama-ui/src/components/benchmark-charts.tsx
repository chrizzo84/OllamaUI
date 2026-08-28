'use client';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { CATEGORICAL } from './dashboard-charts';

ChartJS.register(CategoryScale, LinearScale, LineElement, PointElement, Title, Tooltip, Legend);

const GRID_COLOR = 'rgba(255, 255, 255, 0.06)';
const TICK_COLOR = 'rgba(255, 255, 255, 0.55)';

export interface BenchmarkRunPoint {
  model: string;
  tokensPerSecond: number | null;
  createdAt: number;
}

// Plotted by chronological run order per model ("Run #1, #2, ...") rather
// than on a real time scale — avoids pulling in a chart.js time-scale
// adapter for what's fundamentally a trend view (getting faster/slower over
// successive runs), and keeps models whose runs happened at very different
// times from producing a mostly-empty shared time axis. The actual date
// still shows in the tooltip.
export function BenchmarkCharts({ runs }: { runs: BenchmarkRunPoint[] }) {
  const byModel = new Map<string, BenchmarkRunPoint[]>();
  for (const r of runs) {
    if (r.tokensPerSecond == null) continue;
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  const models = [...byModel.keys()];
  if (models.length === 0) {
    return (
      <div className="text-xs text-white/40 flex items-center justify-center h-48">
        No benchmark data yet — send a few chats or run a manual benchmark.
      </div>
    );
  }
  const maxRuns = Math.max(...models.map((m) => byModel.get(m)!.length));
  const labels = Array.from({ length: maxRuns }, (_, i) => `#${i + 1}`);
  const datasets = models.map((model, idx) => {
    const points = [...byModel.get(model)!].sort((a, b) => a.createdAt - b.createdAt);
    const color = CATEGORICAL[idx % CATEGORICAL.length];
    return {
      label: model,
      data: points.map((p) => p.tokensPerSecond),
      borderColor: color,
      backgroundColor: color,
      pointRadius: 3,
      tension: 0.25,
      spanGaps: true,
    };
  });

  return (
    <div className="h-64">
      <Line
        data={{ labels, datasets }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { labels: { color: TICK_COLOR, boxWidth: 12, font: { size: 11 } } },
            tooltip: {
              callbacks: { label: (ctx) => `${ctx.dataset.label}: ${ctx.formattedValue} tok/s` },
            },
          },
          scales: {
            x: { grid: { color: GRID_COLOR }, ticks: { color: TICK_COLOR, font: { size: 10 } } },
            y: {
              grid: { color: GRID_COLOR },
              ticks: { color: TICK_COLOR, font: { size: 10 } },
              title: { display: true, text: 'tokens/sec', color: TICK_COLOR, font: { size: 10 } },
            },
          },
        }}
      />
    </div>
  );
}
