import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

export const runtime = 'nodejs';

interface CompactMessageIn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SUMMARY_SYSTEM_PROMPT = `You compress chat histories. Summarize the conversation below into a compact context note that lets an assistant seamlessly continue the conversation.

Rules:
- Keep all facts, decisions, constraints, names, numbers and open questions.
- Keep the user's goals and preferences.
- Drop greetings, filler and repetition.
- Write it as dense bullet points.
- Reply with ONLY the summary, no preamble.`;

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

    const transcript = messages
      .map(
        (m) =>
          `${m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'Context' : 'User'}: ${m.content}`,
      )
      .join('\n\n');

    const upstream = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Without this, a hung Ollama host leaves `compacting` stuck true
      // forever, blocking the toolbar action and future auto-compact checks.
      signal: AbortSignal.timeout(90_000),
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: transcript },
        ],
        stream: false,
        think: false,
        options: { temperature: 0.2, num_predict: 1000, ...(numCtx ? { num_ctx: numCtx } : {}) },
      }),
    });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      return new Response(JSON.stringify({ error: txt || 'Compaction failed' }), { status: 502 });
    }
    const data = await upstream.json();
    const raw = data?.message?.content;
    const summary = typeof raw === 'string' ? raw.trim() : '';
    // A real summary of a multi-message conversation is never this short —
    // this catches degenerate completions (seen in practice: a model
    // replying with a single stray backtick) that would otherwise silently
    // replace the older conversation with something useless, which is worse
    // than just failing: the user loses context and gets no error to explain
    // why. MIN_SUMMARY_LENGTH is a floor, not a quality bar.
    const MIN_SUMMARY_LENGTH = 20;
    if (summary.length < MIN_SUMMARY_LENGTH) {
      return new Response(
        JSON.stringify({
          error: summary
            ? `Model returned a suspiciously short summary ("${summary}") — refusing to use it`
            : 'Empty summary response',
        }),
        { status: 502 },
      );
    }
    return Response.json({ summary });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Compaction failed';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
