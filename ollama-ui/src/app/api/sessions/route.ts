import { NextRequest } from 'next/server';
import { z } from 'zod';
import { listSessions, createSession, messageCountsBySession } from '@/lib/db';

const createSchema = z.object({
  profileId: z.string().nullable().optional(),
});

export async function GET() {
  // One grouped COUNT instead of deserializing every conversation just to
  // read its length — see messageCountsBySession in src/lib/db.ts.
  const counts = messageCountsBySession();
  const rows = listSessions().map((r) => ({
    id: r.id,
    title: r.title,
    titleStatus: r.titleStatus,
    profileId: r.profileId,
    modelA: r.modelA,
    modelB: r.modelB,
    compareMode: r.compareMode,
    memoryEnabled: r.memoryEnabled,
    isTelegram: r.isTelegram,
    messageCount: counts.get(r.id) ?? 0,
    updatedAt: r.updated_at,
  }));
  return Response.json({ items: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const row = createSession({ profileId: parsed.data.profileId ?? null });
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
    messages: [],
    updatedAt: row.updated_at,
  });
}
