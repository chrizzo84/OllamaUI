import { NextRequest } from 'next/server';

// Endpoint template persists client-side; for server we still allow env fallback
const FALLBACK =
  (
    process.env.SEARXNG_HOST ||
    process.env.NEXT_PUBLIC_SEARXNG_HOST ||
    'http://localhost:8080'
  ).replace(/\/$/, '') + '/search?q=<query>&format=json';

export const runtime = 'edge';

function buildUrl(template: string, query: string) {
  return template.replace('<query>', encodeURIComponent(query));
}

interface SearxngResultItem {
  title?: string;
  url?: string;
  content?: string;
  pretty_url?: string;
  img_src?: string;
  author?: string;
  engine?: string;
}

interface SearxngResponse {
  results?: SearxngResultItem[];
  answers?: string[];
  infoboxes?: unknown[];
  suggestions?: string[];
  engines?: unknown[];
  [k: string]: unknown;
}

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
    let template = headerTemplate && headerTemplate.includes('<query>') ? headerTemplate : FALLBACK;
    if (!/^https?:\/\//.test(template) || template.length > 500) template = FALLBACK;

    const hasPage = template.includes('<page>');
    const pages = hasPage ? concurrency : 1;

    const pageFetches = Array.from({ length: pages }, (_, i) => {
      const pageNum = i + 1;
      let t = template;
      if (hasPage) t = t.replace('<page>', String(pageNum));
      const fullUrl = buildUrl(t, q);
      return fetch(fullUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    });

    const pageData = (await Promise.all(pageFetches)) as (SearxngResponse | null)[];
    const gathered: SearxngResultItem[] = [];
    for (const d of pageData) {
      if (d?.results) gathered.push(...d.results);
    }
    // basic dedupe by URL
    const seen = new Set<string>();
    const filtered: SearxngResultItem[] = [];
    outer: for (const r of gathered) {
      const url = r.url || ''; // dedupe
      if (url) {
        if (seen.has(url)) continue;
        seen.add(url);
        try {
          const host = new URL(url).hostname.replace(/^www\./, '');
          if (include.length && !include.some((d) => host.endsWith(d))) continue outer;
          if (exclude.some((d) => host.endsWith(d))) continue outer;
        } catch {
          // ignore URL parse errors
        }
      }
      filtered.push(r);
    }
    // score: earlier appearance + snippet length heuristic
    const scored = filtered.map((r, idx) => ({
      r,
      score: 1000 - idx * 2 + (r.content ? Math.min(r.content.length, 400) / 20 : 0),
    }));
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, max).map(({ r }) => ({
      title: r.title,
      url: r.url,
      snippet: r.content,
      engine: r.engine,
    }));
    return new Response(
      JSON.stringify({ query: q, results, total: gathered.length, filtered: results.length }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'search failed';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
