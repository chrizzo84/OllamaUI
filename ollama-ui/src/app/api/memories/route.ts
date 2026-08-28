import { NextRequest } from 'next/server';
import { z } from 'zod';
import { listMemories, createMemory, deleteMemory } from '@/lib/db';

const createSchema = z.object({
  content: z.string().min(1).max(2000),
});

export async function GET() {
  const rows = listMemories().map((r) => ({
    id: r.id,
    content: r.content,
    sourceSessionId: r.sourceSessionId,
    createdAt: r.created_at,
  }));
  return Response.json({ items: rows });
}

// Manual "+ Add fact" from Settings — sourceSessionId stays null (only the
// remember_fact tool, called from within a chat, sets it — see
// src/app/api/chat/route.ts).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const row = createMemory({ content: parsed.data.content });
  return Response.json({
    id: row.id,
    content: row.content,
    sourceSessionId: row.sourceSessionId,
    createdAt: row.created_at,
  });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return new Response('Bad Request', { status: 400 });
  deleteMemory(id);
  return new Response(null, { status: 204 });
}
