import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

export const runtime = 'nodejs';

/**
 * POST /api/stop
 * Body: { model: string }
 *
 * Unloads a model from Ollama memory by calling /api/generate with keep_alive: 0
 * Available since Ollama v0.1.33
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model parameter' }), {
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

    // Use /api/generate with keep_alive: 0 to immediately unload the model
    // This is the documented way to unload models in Ollama
    const upstream = await fetch(`${base}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: '',
        keep_alive: 0,
      }),
    });

    if (!upstream.ok) {
      const errorText = await upstream.text().catch(() => 'Unknown error');
      return new Response(JSON.stringify({ error: `Failed to stop model: ${errorText}` }), {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Ollama returns a streaming response, we just need to confirm it started
    return new Response(JSON.stringify({ success: true, model }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to stop model';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
