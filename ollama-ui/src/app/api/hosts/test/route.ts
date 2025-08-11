import { NextRequest } from 'next/server';
import { validateHost } from '@/lib/env';

export const runtime = 'nodejs';

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  abortController: AbortController,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      abortController.abort();
      reject(new Error('Timeout after ' + ms + 'ms'));
    }, ms);
    promise
      .then((v) => {
        clearTimeout(t);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(t);
        reject(e);
      });
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const raw = typeof body.url === 'string' ? body.url.trim() : '';
    const base = validateHost(raw);
    if (!base) {
      return new Response(JSON.stringify({ ok: false, error: 'Invalid URL' }), { status: 400 });
    }
    const start = Date.now();
    const controller = new AbortController();
    let text = '';
    let status = 0;
    try {
      const res = await withTimeout(
        fetch(base, { signal: controller.signal, headers: { Accept: 'text/plain, */*' } }),
        5000,
        controller,
      );
      status = res.status;
      text = await res.text().catch(() => '');
      const latency = Date.now() - start;
      if (res.ok && /Ollama is running/i.test(text)) {
        return Response.json({ ok: true, message: 'Ollama is running', status, latency });
      }
      // fallback: try /api/tags for a JSON response to confirm connectivity
      const tagsController = new AbortController();
      const res2 = await withTimeout(
        fetch(base.replace(/\/$/, '') + '/api/tags', {
          signal: tagsController.signal,
          headers: { Accept: 'application/json' },
        }),
        5000,
        tagsController,
      );
      const latency2 = Date.now() - start;
      if (res2.ok) {
        return Response.json({
          ok: true,
          message: 'Reachable (tags)',
          status: res2.status,
          latency: latency2,
        });
      }
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'Host reachable but unexpected response',
          status,
          body: text.slice(0, 200),
        }),
        { status: 502 },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Internal error';
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
  }
}
