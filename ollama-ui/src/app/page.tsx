import { Suspense } from 'react';
import { DashboardPanel } from '@/components/dashboard-panel';
import fs from 'fs';
import path from 'path';

export default function DashboardPage() {
  // Read News.md server-side
  const newLocation = path.join(process.cwd(), 'public', 'news', 'News.md');
  const oldLocation = path.join(process.cwd(), 'news', 'News.md');
  const filePath = fs.existsSync(newLocation) ? newLocation : oldLocation;
  let newsContent = '';
  try {
    newsContent = fs.readFileSync(filePath, 'utf8');
  } catch {
    newsContent = '# News\n\n_No release notes file found._';
  }
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-6 py-10 gap-8 overflow-hidden">
      <div className="flex flex-col gap-1.5 mb-4 anim-fade-up">
        <span className="section-label">Overview</span>
        <h1 className="text-3xl font-bold tracking-tight text-gradient-hero">Dashboard</h1>
        <p className="text-sm text-white/40">
          Your local models, host status and release notes at a glance.
        </p>
      </div>
      <Suspense fallback={<div>Loading dashboard…</div>}>
        <DashboardPanel newsContent={newsContent} />
      </Suspense>
    </main>
  );
}
