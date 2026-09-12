/**
 * The review queue: the places the knowledge base disagrees with itself.
 *
 * A contradiction is written whenever a new fact displaces one that said
 * something genuinely different (see remember() in src/lib/db/memories.ts).
 * Surfacing them is the entire point — an unresolved disagreement that
 * nobody sees doesn't go away, it just gets settled at random inside the
 * prompt, differently each time.
 */
import { NextRequest } from 'next/server';
import { z } from 'zod';
import { listContradictions, resolveContradiction, getSession } from '@/lib/db';

export const runtime = 'nodejs';

const resolveSchema = z.object({
  edgeId: z.string().min(1),
  keep: z.enum(['newer', 'older', 'both']),
});

export async function GET() {
  const items = listContradictions().map(({ edge, newer, older }) => ({
    edgeId: edge.id,
    detectedAt: edge.created_at,
    newer: newer
      ? {
          id: newer.id,
          content: newer.content,
          createdAt: newer.created_at,
          sourceSessionId: newer.sourceSessionId,
          // The conversation a fact came from is its evidence; naming it
          // here means deciding doesn't require guessing where it came from.
          sourceSessionTitle: newer.sourceSessionId
            ? (getSession(newer.sourceSessionId)?.title ?? null)
            : null,
        }
      : null,
    older: older
      ? {
          id: older.id,
          content: older.content,
          createdAt: older.created_at,
          sourceSessionId: older.sourceSessionId,
          sourceSessionTitle: older.sourceSessionId
            ? (getSession(older.sourceSessionId)?.title ?? null)
            : null,
        }
      : null,
    subject: newer?.subject ?? older?.subject ?? null,
  }));
  return Response.json({ items });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = resolveSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  resolveContradiction(parsed.data.edgeId, parsed.data.keep);
  return Response.json({ ok: true });
}
