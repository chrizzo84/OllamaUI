import { NextRequest } from 'next/server';

export const runtime = 'edge'; // fast flush for SSE

function encoder() {
  return new TextEncoder();
}

function streamText(text: string, controller: ReadableStreamDefaultController, enc: TextEncoder) {
  const lines = text.split(/\s+/);
  let i = 0;
  const interval = setInterval(() => {
    if (i >= lines.length) {
      controller.enqueue(enc.encode(`data: [END]\n\n`));
      clearInterval(interval);
      controller.close();
    } else {
      controller.enqueue(enc.encode(`data: ${lines[i++]}\n\n`));
    }
  }, 120);
}

export async function GET(_req: NextRequest) {
  const enc = encoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(enc.encode('retry: 3000\n'));
      controller.enqueue(enc.encode('event: ready\n'));
      controller.enqueue(enc.encode('data: streaming-started\n\n'));
      const demoText =
        'Realtime streaming demo powered by native Server-Sent Events via Next.js edge runtime.';
      streamText(demoText, controller, enc);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
