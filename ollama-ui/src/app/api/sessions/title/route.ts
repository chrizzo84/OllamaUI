import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { generateSessionTitle } from '@/lib/session-title';

export const runtime = 'nodejs';

/*
POST body: { model: string, firstUserMessage: string, firstAssistantMessage?: string }
Thin wrapper around generateSessionTitle() (src/lib/session-title.ts), which
is also called directly, in-process, from the server-side chat-completion
path (src/lib/chat-persistence.ts) — this route exists for any caller that
isn't already inside the Node server (or wants the HTTP contract directly).
*/
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    const firstUserMessage = ((body.firstUserMessage as string | undefined) || '').trim();
    const firstAssistantMessage = ((body.firstAssistantMessage as string | undefined) || '').trim();
    if (!model || !firstUserMessage) {
      return new Response(JSON.stringify({ error: 'Missing model or firstUserMessage' }), {
        status: 400,
      });
    }
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
      });
    }
    const title = await generateSessionTitle(base, model, firstUserMessage, firstAssistantMessage);
    return Response.json({ title });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Title generation failed';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
