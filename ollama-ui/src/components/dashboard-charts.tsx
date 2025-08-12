'use client';
import { Bar, Pie } from 'react-chartjs-2';
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

export function DashboardCharts({ models }: { models: { name: string; size: number }[] }) {
  if (!models || models.length === 0) return <div>No chart data available.</div>;

  // Bar chart: Model sizes
  const barData = {
    labels: models.map((m) => m.name),
    datasets: [
      {
        label: 'Model Size (MB)',
        data: models.map((m) => m.size / 1024 / 1024),
        backgroundColor: 'rgba(99, 102, 241, 0.6)',
      },
    ],
  };
  const barOptions = {
    responsive: true,
    plugins: {
      legend: { display: false },
      title: { display: true, text: 'Model Size Distribution' },
    },
    scales: {
      x: { ticks: { color: '#fff' } },
      y: { ticks: { color: '#fff' } },
    },
  };

  // Pie chart: Size share per model
  const pieData = {
    labels: models.map((m) => m.name),
    datasets: [
      {
        label: 'Size Share',
        data: models.map((m) => m.size),
        backgroundColor: models.map((_, i) => `hsl(${(i * 40) % 360}, 70%, 60%)`),
      },
    ],
  };
  const pieOptions = {
    responsive: true,
    plugins: {
      legend: { labels: { color: '#fff' } },
      title: { display: true, text: 'Model Size Share' },
    },
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-6">
      <div className="bg-white/5 border border-white/10 rounded-lg p-4">
        <Bar data={barData} options={barOptions} />
      </div>
      <div className="bg-white/5 border border-white/10 rounded-lg p-4">
        <Pie data={pieData} options={pieOptions} />
      </div>
    </div>
  );
}
