import { NextRequest } from 'next/server';
import { abortJob, createJobEventStream } from '@/lib/generation-jobs';

// Must be nodejs, not edge — the job registry is an in-memory module
// singleton that only exists in this runtime's process, the same one
// src/app/api/chat/route.ts runs in. An edge-runtime build of this route
// would execute in a separate isolate that never sees the job, silently
// making Stop/reconnect a no-op.
export const runtime = 'nodejs';

// GET /api/chat/jobs/:id — reconnect to a generation job that's still
// running (or just finished) server-side, e.g. after a fresh page load or a
// different tab/device. Emits a one-off catch-up snapshot first, then tails
// the job live exactly like the initial POST /api/chat response — same
// NDJSON wire format, no client-side changes needed to consume it. 404 means
// there's nothing to reconnect to (job already evicted, or never existed);
// the caller should fall back to whatever's already persisted in the DB.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const stream = createJobEventStream(id);
  if (!stream) {
    return new Response(JSON.stringify({ error: 'No running job' }), { status: 404 });
  }
  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache',
    },
  });
}

// DELETE /api/chat/jobs/:id — explicit user-initiated Stop. Aborts the
// generation job identified by :id (== the assistant message's id). No-op if
// the job is unknown or already settled — races with natural completion are
// expected and harmless.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  abortJob(id);
  return new Response(null, { status: 204 });
}
