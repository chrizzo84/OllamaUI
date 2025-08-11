import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = body.model as string | undefined;
    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model name' }), { status: 400 });
    }

    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const upstream = await fetch(`${base}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });

    if (!upstream.body) {
      const text = await upstream.text();
      return new Response(text || JSON.stringify({ error: 'No body from upstream' }), {
        status: upstream.status,
      });
    }

    // Transform to normalized JSON lines adding computed percentage if missing.
    const transformed = new ReadableStream({
      async start(controller) {
        const reader = upstream.body!.getReader();
        const decoder = new TextDecoder();
        const encoder = new TextEncoder();
        let buffer = '';
        function emit(obj: unknown) {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        }
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
              const parsed = JSON.parse(line);
              // Ollama may provide {status: string, digest?, total?, completed?}
              if (parsed.total && parsed.completed && !parsed.percentage) {
                parsed.percentage = Math.round((parsed.completed / parsed.total) * 100);
              }
              emit(parsed);
            } catch {
              emit({ raw: line });
            }
          }
        }
        if (buffer.trim()) emit({ raw: buffer.trim() });
        emit({ done: true });
        controller.close();
      },
    });

    return new Response(transformed, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to pull model';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
