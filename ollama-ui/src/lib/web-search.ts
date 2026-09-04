// Core SearXNG-backed web search logic, extracted so it can be called both
// from the standalone /api/tools/web-search route and directly (in-process)
// from the /api/chat tool-calling loop.

// A hung SearXNG backend previously stalled the whole tool call (and the
// chat turn waiting on it) indefinitely. Bound each page fetch.
const SEARCH_TIMEOUT_MS = 20_000;

const FALLBACK =
  (
    process.env.SEARXNG_HOST ||
    process.env.NEXT_PUBLIC_SEARXNG_HOST ||
    'http://localhost:8080'
  ).replace(/\/$/, '') + '/search?q=<query>&format=json';

function buildUrl(template: string, query: string) {
  return template.replace('<query>', encodeURIComponent(query));
}

// Host only — the full URL carries the user's search terms, which have no
// business in an error string that ends up in a chat reply or a log line.
function endpointLabel(template: string): string {
  try {
    return new URL(template.replace('<query>', 'x').replace('<page>', '1')).host;
  } catch {
    return 'the configured endpoint';
  }
}

// One page fetch's outcome. `error` is set instead of `data` when the page
// could not be turned into a SearXNG response at all.
interface PageOutcome {
  data: SearxngResponse | null;
  error?: string;
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
  /*
  Set only when SOME pages failed while others succeeded — the results are
  usable but incomplete. A run where every page failed never gets here:
  performWebSearch throws instead, so a broken backend can't masquerade as
  a genuinely empty result set.
  */
  warnings?: string[];
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
    return fetch(fullUrl, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    })
      .then(async (r): Promise<PageOutcome> => {
        if (!r.ok)
          return { data: null, error: `HTTP ${r.status}${r.statusText ? ' ' + r.statusText : ''}` };
        try {
          return { data: (await r.json()) as SearxngResponse };
        } catch {
          // Reached a server, but it didn't answer with JSON. Overwhelmingly
          // this is either a SearXNG whose `json` output format isn't
          // enabled in settings.yml (it serves the HTML page instead), or a
          // completely different service listening on that port.
          const ct = r.headers.get('content-type') || 'unknown';
          return {
            data: null,
            error: `response was not JSON (content-type: ${ct}) — check that this is a SearXNG instance and that its JSON format is enabled`,
          };
        }
      })
      .catch((e: unknown) => ({
        data: null,
        error: e instanceof Error ? e.message : 'request failed',
      }));
  });

  const outcomes = await Promise.all(pageFetches);
  const errors = outcomes.flatMap((o) => (o.error ? [o.error] : []));
  /*
  Every page failed. This is a broken/misconfigured search backend, NOT an
  empty result set, and the difference matters enormously: returning
  `{results: []}` here reads to the model as "the web has nothing on this",
  which it then answers from memory — confidently and often with invented
  figures, while the user sees a tool call that apparently succeeded.
  Throwing turns it into a tool error the model is explicitly told about
  (executeTool in generation-runner.ts wraps it as `{error}`), and gives
  whoever is debugging the actual reason instead of silence.
  */
  if (outcomes.length > 0 && errors.length === outcomes.length) {
    throw new Error(`SearXNG request to ${endpointLabel(template)} failed: ${errors[0]}`);
  }
  const gathered: SearxngResultItem[] = [];
  for (const { data } of outcomes) {
    if (data?.results) gathered.push(...data.results);
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

  return {
    query: q,
    results,
    total: gathered.length,
    filtered: results.length,
    ...(errors.length ? { warnings: errors } : {}),
  };
}
