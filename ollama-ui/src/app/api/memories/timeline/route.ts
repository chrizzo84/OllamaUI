/**
 * What happened to the knowledge base, in order — the answer to "why does it
 * think that", which is usually "because of something it was told on a
 * particular day".
 *
 * The events are derived from the facts themselves rather than logged
 * separately, so there is no second source of truth to drift out of sync
 * with them.
 */
import { NextRequest } from 'next/server';
import { listTimeline, getSession } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const limit = Number(searchParams.get('limit') ?? '150');
  const events = listTimeline(Number.isFinite(limit) ? Math.min(500, Math.max(10, limit)) : 150);
  return Response.json({
    items: events.map((e) => ({
      ...e,
      sourceSessionTitle: e.sourceSessionId ? (getSession(e.sourceSessionId)?.title ?? null) : null,
    })),
  });
}
