import { NextRequest } from 'next/server';
import { z } from 'zod';
import { listSessions, createSession } from '@/lib/db';

const createSchema = z.object({
  profileId: z.string().nullable().optional(),
});

export async function GET() {
  const rows = listSessions().map((r) => ({
    id: r.id,
    title: r.title,
    titleStatus: r.titleStatus,
    profileId: r.profileId,
    modelA: r.modelA,
    modelB: r.modelB,
    compareMode: r.compareMode,
    messageCount: r.messages.length,
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
    messages: row.messages,
    updatedAt: row.updated_at,
  });
}
