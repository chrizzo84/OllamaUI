import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  listMemories,
  remember,
  deleteMemory,
  listContradictions,
  type MemoryRow,
  type MemoryStatus,
} from '@/lib/db';

const createSchema = z.object({
  content: z.string().min(1).max(2000),
});

function toApi(r: MemoryRow) {
  return {
    id: r.id,
    content: r.content,
    type: r.type,
    subject: r.subject,
    status: r.status,
    supersededBy: r.supersededBy,
    confidence: r.confidence,
    pinned: r.pinned,
    useCount: r.useCount,
    lastUsedAt: r.lastUsedAt,
    sourceSessionId: r.sourceSessionId,
    createdAt: r.created_at,
  };
}

/**
 * `items` is what the assistant can actually use, which is the question the
 * Memory panel exists to answer — a superseded fact is history and a draft
 * is not in play yet, so mixing all three into one list would show facts as
 * current that the model will never see.
 *
 * `?status=` asks for one specific set (superseded for the history view,
 * draft for the review queue); `?status=all` returns everything.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const requested = searchParams.get('status');
  const status = (requested && requested !== 'all' ? requested : undefined) as
    MemoryStatus | undefined;
  const rows = requested === 'all' ? listMemories() : listMemories({ status: status ?? 'active' });
  return Response.json({
    items: rows.map(toApi),
    // Surfaced alongside the list rather than behind their own request: a
    // fact saved for review that nobody is told about is a fact that stays
    // invisible forever, and an unresolved contradiction is the one thing
    // here worth interrupting someone for.
    draftCount: listMemories({ status: 'draft' }).length,
    contradictionCount: listContradictions().length,
  });
}

// Manual "+ Add fact" from Settings — sourceSessionId stays null (only the
// remember_fact tool, called from within a chat, sets it — see
// src/app/api/chat/route.ts). Goes through remember() like every other write,
// so a hand-typed fact displaces an outdated one and is de-duplicated the
// same way the model's own writes are.
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const stored = remember({ content: parsed.data.content });
  return Response.json({
    ...toApi(stored.memory),
    alreadyKnown: stored.duplicate,
    replaced: stored.superseded ? toApi(stored.superseded) : null,
  });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return new Response('Bad Request', { status: 400 });
  deleteMemory(id);
  return new Response(null, { status: 204 });
}
