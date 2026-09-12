/**
 * Starting, watching and stopping a pass over past conversations for facts
 * nobody collected at the time — see src/lib/memory-backfill.ts.
 *
 * The run is detached from the request that starts it, the same way an
 * evaluation run and a chat generation are: a long history is many minutes
 * of model time, and closing the tab must not abandon it. Progress is polled
 * rather than streamed, because a poll every couple of seconds is enough for
 * a counter and needs no connection kept open.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { getBackfillProgress, startBackfill, stopBackfill } from '@/lib/memory-backfill';

export const runtime = 'nodejs';

const startSchema = z.object({
  model: z.string().min(1),
  limit: z.number().int().min(1).max(2000).optional(),
});

export async function GET() {
  return Response.json(getBackfillProgress());
}

export async function POST(req: NextRequest) {
  const base = resolveOllamaHostServer();
  if (!base) {
    return Response.json(
      { error: 'No active Ollama host configured', code: 'NO_HOST' },
      { status: 428 },
    );
  }
  const body = await req.json().catch(() => ({}));
  const parsed = startSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });

  const started = startBackfill({ base, model: parsed.data.model, limit: parsed.data.limit });
  if (!started) {
    // Not an error: a second click while one is running should be a no-op
    // with the current state, not a failure the user has to interpret.
    return Response.json({ ...getBackfillProgress(), alreadyRunning: true });
  }
  return Response.json(getBackfillProgress());
}

export async function DELETE() {
  const stopped = stopBackfill();
  return Response.json({ ...getBackfillProgress(), stopped });
}
