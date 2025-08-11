import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  try {
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
      });
    }
    const upstream = await fetch(`${base}/api/ps`, { cache: 'no-store' });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch process list';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
