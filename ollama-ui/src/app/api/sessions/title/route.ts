import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

export const runtime = 'nodejs';

function sanitizeTitle(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\.$/, '');
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t;
}

/*
POST body: { model: string, firstUserMessage: string, firstAssistantMessage?: string }
Non-streaming, best-effort short title generation for a new chat session.
Callers should fall back to a truncated first message on any error — this
endpoint is a nice-to-have and must never block the chat itself.
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
    const prompt = `Conversation:\nUser: ${firstUserMessage.slice(0, 500)}\nAssistant: ${firstAssistantMessage.slice(0, 500)}\n\nReply with only a short 3-6 word title for this conversation. No quotes, no punctuation, no preamble.`;
    const upstream = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { num_predict: 20, temperature: 0.3 },
      }),
    });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      return new Response(JSON.stringify({ error: txt || 'Title generation failed' }), {
        status: 502,
      });
    }
    const data = await upstream.json();
    const raw = data?.message?.content;
    if (typeof raw !== 'string' || !raw.trim()) {
      return new Response(JSON.stringify({ error: 'Empty title response' }), { status: 502 });
    }
    return Response.json({ title: sanitizeTitle(raw) });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Title generation failed';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
