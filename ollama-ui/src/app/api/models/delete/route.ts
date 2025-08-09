import { NextRequest } from 'next/server';
import { resolveOllamaHost } from '@/lib/env';

export const runtime = 'edge';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = body.model as string | undefined;
    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model name' }), { status: 400 });
    }

    const base = resolveOllamaHost(req);
    const upstream = await fetch(`${base}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      return new Response(text || JSON.stringify({ error: 'Upstream delete failed' }), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const result = await upstream.json().catch(() => ({}));
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Delete failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
