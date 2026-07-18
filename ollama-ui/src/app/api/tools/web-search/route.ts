import { NextRequest } from 'next/server';
import { performWebSearch } from '@/lib/web-search';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get('q');
  const max = Math.min(Number(searchParams.get('max') || '5'), 15);
  const include = (searchParams.get('include') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const exclude = (searchParams.get('exclude') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const concurrency = Math.min(Math.max(Number(searchParams.get('concurrency') || '1'), 1), 5);
  if (!q) return new Response(JSON.stringify({ error: 'missing q' }), { status: 400 });
  try {
    const headerTemplate = req.headers.get('x-searxng-endpoint-template');
    const result = await performWebSearch({
      query: q,
      max,
      include,
      exclude,
      concurrency,
      endpointTemplate: headerTemplate,
    });
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'search failed';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
