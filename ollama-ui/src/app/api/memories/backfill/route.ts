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
import { clearScanHistory } from '@/lib/db';

export const runtime = 'nodejs';

const startSchema = z.object({
  model: z.string().min(1),
  limit: z.number().int().min(1).max(2000).optional(),
});

export async function GET() {
  return Response.json(getBackfillProgress());
}

export async function POST(req: NextRequest) {
  /*
  Forgetting what was already examined, so the history can be read again.

  Needed because "examined" is a one-way mark: a pass that ran with a model
  whose template has no tool support, or against a host that was down, used
  to retire every conversation it touched while reporting that it found
  nothing. Even now that a failed call no longer marks anything, a *weak*
  model still answers honestly and badly — and without this the only way
  back would be editing the database. The drafts already written are left
  alone; re-reading writes drafts, and the duplicate check catches the rest.
  */
  const raw = (await req
    .clone()
    .json()
    .catch(() => ({}))) as { reset?: boolean };
  if (raw.reset) {
    if (getBackfillProgress().status === 'running') {
      return Response.json({ error: 'A run is in progress', code: 'RUNNING' }, { status: 409 });
    }
    clearScanHistory();
    return Response.json(getBackfillProgress());
  }

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
