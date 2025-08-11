import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

interface UpstreamMessageChunk {
  message?: { content?: string };
  response?: string; // fallback style
  done?: boolean;
  [key: string]: unknown;
}

export const runtime = 'nodejs';

/*
POST body: { model: string, messages: { role: 'user'|'assistant'|'system', content: string }[], stream?: boolean }
Proxy to Ollama /api/chat with streaming, normalizing output to NDJSON lines.
*/
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model' }), { status: 400 });
    }
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const upstream = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages, stream: true }),
    });
    if (!upstream.body) {
      const txt = await upstream.text();
      return new Response(txt || JSON.stringify({ error: 'No upstream body' }), {
        status: upstream.status,
      });
    }

    let aggregated = '';
    let lastCumulative = '';
    const transformed = new ReadableStream({
      async start(controller) {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        function emit(obj: unknown) {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        }
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line) continue;
            try {
              const parsed: UpstreamMessageChunk = JSON.parse(line) as UpstreamMessageChunk;
              if (parsed.message && typeof parsed.message.content === 'string') {
                const cumulative = parsed.message.content;
                let delta = cumulative;
                if (cumulative.startsWith(lastCumulative)) {
                  delta = cumulative.slice(lastCumulative.length);
                }
                aggregated += delta;
                lastCumulative = cumulative;
                if (delta) emit({ token: delta, model });
                if (parsed.done) {
                  emit({ done: true, model, content: aggregated });
                }
              } else if (typeof parsed.response === 'string') {
                // fallback to generate style
                const token = parsed.response;
                aggregated += token;
                emit({ token, model });
                if (parsed.done) emit({ done: true, model, content: aggregated });
              } else emit(parsed);
            } catch {
              emit({ raw: line });
            }
          }
        }
        if (buffer.trim()) emit({ raw: buffer.trim() });
        if (!aggregated) emit({ info: 'empty response', model });
        controller.close();
      },
    });

    return new Response(transformed, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Chat failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
