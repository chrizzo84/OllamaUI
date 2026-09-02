import { NextRequest } from 'next/server';
import { z } from 'zod';
import {
  getSession,
  updateSession,
  deleteSession,
  listMessagesWithVariants,
  replaceAllMessages,
} from '@/lib/db';

const patchSchema = z.object({
  title: z.string().min(1).optional(),
  titleStatus: z.enum(['pending', 'ready']).optional(),
  profileId: z.string().nullable().optional(),
  modelA: z.string().optional(),
  modelB: z.string().optional(),
  compareMode: z.boolean().optional(),
  memoryEnabled: z.boolean().nullable().optional(),
  messages: z.array(z.record(z.string(), z.unknown())).optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = getSession(id);
  if (!row) return new Response('Not Found', { status: 404 });
  return Response.json({
    id: row.id,
    title: row.title,
    titleStatus: row.titleStatus,
    profileId: row.profileId,
    modelA: row.modelA,
    modelB: row.modelB,
    compareMode: row.compareMode,
    memoryEnabled: row.memoryEnabled,
    isTelegram: row.isTelegram,
    messages: [...listMessagesWithVariants(id, 'A'), ...listMessagesWithVariants(id, 'B')],
    updatedAt: row.updated_at,
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const { messages, ...meta } = parsed.data;
  const row = updateSession(id, meta as Parameters<typeof updateSession>[1]);
  if (!row) return new Response('Not Found', { status: 404 });
  // A messages array in the patch means "this is the conversation now" —
  // the client rewrote history (compaction, undo, deleting a message).
  // Metadata and messages live in different tables now, so they are written
  // separately. The array is flat across both compare columns; see
  // replaceAllMessages for why that has to be partitioned rather than
  // written as one list.
  if (messages)
    replaceAllMessages(id, messages as unknown as Parameters<typeof replaceAllMessages>[1]);
  return Response.json({
    id: row.id,
    title: row.title,
    titleStatus: row.titleStatus,
    profileId: row.profileId,
    modelA: row.modelA,
    modelB: row.modelB,
    compareMode: row.compareMode,
    memoryEnabled: row.memoryEnabled,
    isTelegram: row.isTelegram,
    updatedAt: row.updated_at,
  });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const existing = getSession(id);
  if (!existing) return new Response('Not Found', { status: 404 });
  deleteSession(id);
  return new Response(null, { status: 204 });
}
