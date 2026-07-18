import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

export const runtime = 'nodejs';

/**
 * POST /api/models/show
 * Body: { model: string }
 *
 * Thin proxy to Ollama's /api/show, used to read a model's declared
 * `capabilities` (e.g. "tools", "thinking") so the UI can gate features
 * without guessing from the model name.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const upstream = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch model info';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
