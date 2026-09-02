import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performWebSearch } from './web-search';

type SearxResult = { title?: string; url?: string; content?: string; engine?: string };

const fetchMock = vi.fn();

function respondWith(results: SearxResult[]) {
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ results }) });
}

function lastUrl(): string {
  return fetchMock.mock.calls.at(-1)![0] as string;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  respondWith([]);
});
afterEach(() => vi.unstubAllGlobals());

const r = (host: string, i = 0): SearxResult => ({
  title: `t${i}`,
  url: `https://${host}/page${i}`,
  content: 'snippet',
  engine: 'duckduckgo',
});

describe('performWebSearch', () => {
  it('maps SearXNG results into the tool shape', async () => {
    respondWith([r('example.com')]);
    const out = await performWebSearch({ query: 'weather', endpointTemplate: null });
    expect(out.query).toBe('weather');
    expect(out.results[0]).toEqual({
      title: 't0',
      url: 'https://example.com/page0',
      snippet: 'snippet',
      engine: 'duckduckgo',
    });
  });

  it('url-encodes the query into the template', async () => {
    await performWebSearch({
      query: 'a b&c',
      endpointTemplate: 'http://searx.local/search?q=<query>&format=json',
    });
    expect(lastUrl()).toBe('http://searx.local/search?q=a%20b%26c&format=json');
  });

  it('caps results at the requested max', async () => {
    respondWith(Array.from({ length: 30 }, (_, i) => r(`d${i}.com`, i)));
    const out = await performWebSearch({ query: 'q', max: 3, endpointTemplate: null });
    expect(out.results).toHaveLength(3);
  });

  it('hard-caps results at 15 regardless of what is asked for', async () => {
    respondWith(Array.from({ length: 40 }, (_, i) => r(`d${i}.com`, i)));
    const out = await performWebSearch({ query: 'q', max: 999, endpointTemplate: null });
    expect(out.results).toHaveLength(15);
  });

  it('deduplicates identical URLs', async () => {
    respondWith([r('example.com'), r('example.com'), r('other.com', 1)]);
    const out = await performWebSearch({ query: 'q', endpointTemplate: null });
    expect(out.results).toHaveLength(2);
  });

  it('applies an include-domain filter, ignoring a www. prefix', async () => {
    respondWith([
      { url: 'https://www.wikipedia.org/a', title: 'wiki' },
      { url: 'https://spam.example/b', title: 'spam' },
    ]);
    const out = await performWebSearch({
      query: 'q',
      include: ['wikipedia.org'],
      endpointTemplate: null,
    });
    expect(out.results.map((x) => x.title)).toEqual(['wiki']);
  });

  it('applies an exclude-domain filter', async () => {
    respondWith([
      { url: 'https://good.com/a', title: 'good' },
      { url: 'https://spam.example/b', title: 'spam' },
    ]);
    const out = await performWebSearch({
      query: 'q',
      exclude: ['spam.example'],
      endpointTemplate: null,
    });
    expect(out.results.map((x) => x.title)).toEqual(['good']);
  });

  it('keeps a result whose URL cannot be parsed rather than dropping it', async () => {
    respondWith([{ url: 'not-a-url', title: 'weird' }]);
    const out = await performWebSearch({ query: 'q', endpointTemplate: null });
    expect(out.results.map((x) => x.title)).toEqual(['weird']);
  });

  it('falls back to the default endpoint when the template lacks <query>', async () => {
    await performWebSearch({
      query: 'q',
      endpointTemplate: 'http://searx.local/search?format=json',
    });
    expect(lastUrl()).toContain('q=q');
  });

  it('falls back when the template is not http(s) — no file:// or javascript: fetches', async () => {
    await performWebSearch({ query: 'q', endpointTemplate: 'file:///etc/passwd?q=<query>' });
    expect(lastUrl()).toMatch(/^https?:\/\//);
  });

  it('falls back when the template is absurdly long', async () => {
    const long = 'http://x.local/?q=<query>&pad=' + 'a'.repeat(600);
    await performWebSearch({ query: 'q', endpointTemplate: long });
    expect(lastUrl().length).toBeLessThan(500);
  });

  it('fetches one page per concurrency slot when the template is paginated', async () => {
    await performWebSearch({
      query: 'q',
      concurrency: 3,
      endpointTemplate: 'http://searx.local/search?q=<query>&pageno=<page>&format=json',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls.some((u) => u.includes('pageno=1'))).toBe(true);
    expect(urls.some((u) => u.includes('pageno=3'))).toBe(true);
  });

  it('fetches a single page when the template is not paginated', async () => {
    await performWebSearch({ query: 'q', concurrency: 5, endpointTemplate: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clamps concurrency to at most 5 pages', async () => {
    await performWebSearch({
      query: 'q',
      concurrency: 99,
      endpointTemplate: 'http://s.local/?q=<query>&p=<page>',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('returns an empty result set instead of throwing when the backend is down', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await performWebSearch({ query: 'q', endpointTemplate: null });
    expect(out.results).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('returns an empty result set on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
    const out = await performWebSearch({ query: 'q', endpointTemplate: null });
    expect(out.results).toEqual([]);
  });

  it('bounds each fetch with a timeout signal', async () => {
    await performWebSearch({ query: 'q', endpointTemplate: null });
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reports total (pre-dedupe) separately from filtered (returned)', async () => {
    respondWith([r('a.com'), r('a.com'), r('b.com', 1)]);
    const out = await performWebSearch({ query: 'q', endpointTemplate: null });
    expect(out.total).toBe(3);
    expect(out.filtered).toBe(2);
  });
});
