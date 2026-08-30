import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { compactMessages, type CompactMessageIn } from '@/lib/compact';

export const runtime = 'nodejs';

/*
POST body: { model: string, messages: { role, content }[] }
Non-streaming: asks the model to compress the given (older) part of a
conversation into a dense summary used as replacement context.
*/
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    const messages: CompactMessageIn[] = Array.isArray(body.messages) ? body.messages : [];
    const numCtx =
      typeof body.numCtx === 'number' && body.numCtx > 0 ? Math.floor(body.numCtx) : undefined;
    if (!model || messages.length === 0) {
      return new Response(JSON.stringify({ error: 'Missing model or messages' }), { status: 400 });
    }
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
      });
    }

    const summary = await compactMessages({ base, model, messages, numCtx });
    return Response.json({ summary });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Compaction failed';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
