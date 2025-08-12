import fs from 'fs';
import path from 'path';
import { NewsViewer } from '@/components/news-viewer';

export default async function NewsPage() {
  // Primary location (after move): /public/news/News.md (served at /news/News.md).
  // Backward compatibility: also check old location at /news/News.md (repo root) if new one missing.
  const newLocation = path.join(process.cwd(), 'public', 'news', 'News.md');
  const oldLocation = path.join(process.cwd(), 'news', 'News.md');
  const filePath = fs.existsSync(newLocation) ? newLocation : oldLocation;
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    content = '# News\n\n_No release notes file found._';
  }
  return (
    <div className="relative mx-auto flex min-h-[calc(100vh-3.5rem)] w-full max-w-4xl flex-col gap-10 px-8 py-14">
      {/* Heading removed per request */}
      <NewsViewer content={content} />
      <div className="mt-4 text-[10px] text-white/30">
        Source: {filePath.includes('/public/') ? 'public/news/News.md' : 'news/News.md'} (GFM)
      </div>
    </div>
  );
}
