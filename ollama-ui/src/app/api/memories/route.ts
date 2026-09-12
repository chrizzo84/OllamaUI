import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  listMemories,
  listMemoryHistory,
  remember,
  deleteMemory,
  archiveMemory,
  approveMemory,
  setMemoryPinned,
  updateMemoryClassification,
  listContradictions,
  isMemoryType,
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

  // ?subject= asks what was believed about one thing over time, oldest
  // first — the history view. Superseded rows are the point here, so this
  // deliberately ignores the status filter below.
  const subject = searchParams.get('subject');
  if (subject) {
    return Response.json({ items: listMemoryHistory(subject).map(toApi) });
  }

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

const patchSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['approve', 'archive', 'pin', 'unpin', 'classify']),
  type: z.string().optional(),
  subject: z.string().nullable().optional(),
});

/**
 * The actions the Memory page offers on one fact. Deliberately named by
 * intent rather than by field: "archive" and "approve" are decisions, and
 * keeping them apart from a generic field update is what keeps the status
 * machine in one place (src/lib/db/memories.ts) instead of spread across a
 * form.
 */
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const { id, action } = parsed.data;
  switch (action) {
    case 'approve':
      approveMemory(id);
      break;
    case 'archive':
      archiveMemory(id);
      break;
    case 'pin':
      setMemoryPinned(id, true);
      break;
    case 'unpin':
      setMemoryPinned(id, false);
      break;
    case 'classify':
      updateMemoryClassification(id, {
        type: isMemoryType(parsed.data.type) ? parsed.data.type : undefined,
        subject: parsed.data.subject,
      });
      break;
  }
  const rows = listMemories().filter((m) => m.id === id);
  return Response.json(rows[0] ? toApi(rows[0]) : { ok: true });
}
