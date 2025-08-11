import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

export const runtime = 'nodejs';

// Ollama default list models endpoint: GET /api/tags
// We proxy to avoid CORS / client network exposure and to allow future auth.

export async function GET(req: NextRequest) {
  try {
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const res = await fetch(`${base}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      // Edge fetch: ensure no caching stale data
      cache: 'no-store',
    });
    if (!res.ok) {
      return new Response(
        JSON.stringify({ error: 'Upstream error', status: res.status, statusText: res.statusText }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return new Response(JSON.stringify({ error: 'Fetch failed', message: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
