import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { recordBenchmarkRun } from '@/lib/db';

export const runtime = 'nodejs';

// Fixed, non-configurable prompt so every model gets measured against the
// exact same workload — that's the whole point of the manual benchmark vs.
// the passive per-chat logging (real prompts vary wildly in length/shape).
const BENCHMARK_PROMPT =
  'Write a short paragraph (3-4 sentences) explaining how photosynthesis works.';

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number; // nanoseconds
}

// A single, non-streaming measurement for one model — deliberately outside
// the job-registry/session-persist path used by real chats (src/app/api/chat/route.ts):
// this isn't a conversation, it's a measurement, so it shouldn't create a
// session or a message. The "run for all installed models" flow (see
// benchmark-panel.tsx) calls this once per model, sequentially, from the
// client — not a server-side batch endpoint — so results reflect one model
// actually running at a time.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const model = (body.model as string | undefined)?.trim();
  if (!model) return new Response(JSON.stringify({ error: 'Missing model' }), { status: 400 });

  const base = resolveOllamaHostServer(req);
  if (!base) {
    return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
      status: 428,
    });
  }

  try {
    const upstream = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Generous — a cold model load counts against this too, and load time
      // doesn't affect the tokens/sec measurement itself (that's computed
      // from eval_count/eval_duration, generation-only).
      signal: AbortSignal.timeout(5 * 60_000),
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: BENCHMARK_PROMPT }],
        stream: false,
      }),
    });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => '');
      return new Response(JSON.stringify({ error: txt || `Upstream error (${upstream.status})` }), {
        status: 502,
      });
    }
    const data = (await upstream.json()) as OllamaChatResponse;
    if (data.error) {
      return new Response(JSON.stringify({ error: data.error }), { status: 502 });
    }
    const promptTokens = data.prompt_eval_count;
    const completionTokens = data.eval_count;
    const tokensPerSecond =
      data.eval_count && data.eval_duration
        ? Math.round((data.eval_count / (data.eval_duration / 1e9)) * 10) / 10
        : undefined;
    recordBenchmarkRun({
      model,
      source: 'manual',
      promptTokens,
      completionTokens,
      tokensPerSecond,
    });
    return Response.json({ model, promptTokens, completionTokens, tokensPerSecond });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Benchmark request failed';
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
}
