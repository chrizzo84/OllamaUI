// Core SearXNG-backed web search logic, extracted so it can be called both
// from the standalone /api/tools/web-search route and directly (in-process)
// from the /api/chat tool-calling loop.

const FALLBACK =
  (
    process.env.SEARXNG_HOST ||
    process.env.NEXT_PUBLIC_SEARXNG_HOST ||
    'http://localhost:8080'
  ).replace(/\/$/, '') + '/search?q=<query>&format=json';

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

export interface WebSearchResultItem {
  title?: string;
  url?: string;
  snippet?: string;
  engine?: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResultItem[];
  total: number;
  filtered: number;
}

export interface WebSearchOptions {
  query: string;
  max?: number;
  include?: string[];
  exclude?: string[];
  concurrency?: number;
  endpointTemplate?: string | null;
}

export async function performWebSearch(opts: WebSearchOptions): Promise<WebSearchResponse> {
  const q = opts.query;
  const max = Math.min(opts.max || 5, 15);
  const include = opts.include || [];
  const exclude = opts.exclude || [];
  const concurrency = Math.min(Math.max(opts.concurrency || 1, 1), 5);

  let template =
    opts.endpointTemplate && opts.endpointTemplate.includes('<query>')
      ? opts.endpointTemplate
      : FALLBACK;
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

  return { query: q, results, total: gathered.length, filtered: results.length };
}
