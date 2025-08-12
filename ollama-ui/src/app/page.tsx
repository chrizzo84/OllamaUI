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
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-5xl flex-col px-6 py-10 gap-8 overflow-hidden">
      <h1 className="text-2xl font-bold tracking-tight bg-gradient-to-r from-white via-white/80 to-white/40 bg-clip-text text-transparent mb-4">
        Dashboard
      </h1>
      <Suspense fallback={<div>Loading dashboard…</div>}>
        <DashboardPanel newsContent={newsContent} />
      </Suspense>
    </main>
  );
}
