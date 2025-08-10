import { NextRequest } from 'next/server';
import { safeUuid } from '@/lib/utils';
import { z } from 'zod';
import { listLamas, createLama, updateLama, deleteLama, getLama, importLamas } from '@/lib/db';

const createSchema = z.object({
  name: z.string().min(1),
  prompt: z.string().optional(),
  tags: z.array(z.string()).max(20).optional(),
});

export async function GET() {
  const rows = listLamas().map((r) => ({
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    tags: JSON.parse(r.tags),
    updatedAt: r.updated_at,
  }));
  return Response.json({ items: rows });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const id = safeUuid();
  const row = createLama({ id, ...parsed.data });
  return Response.json({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    tags: JSON.parse(row.tags),
    updatedAt: row.updated_at,
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json();
  const schema = z.object({
    id: z.string(),
    name: z.string().optional(),
    prompt: z.string().optional(),
    tags: z.array(z.string()).max(20).optional(),
  });
  const parsed = schema.safeParse(body);
  if (!parsed.success) return new Response('Bad Request', { status: 400 });
  const updated = updateLama(parsed.data.id, parsed.data);
  if (!updated) return new Response('Not Found', { status: 404 });
  return Response.json({
    id: updated.id,
    name: updated.name,
    prompt: updated.prompt,
    tags: JSON.parse(updated.tags),
    updatedAt: updated.updated_at,
  });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) return new Response('Bad Request', { status: 400 });
  const existing = getLama(id);
  if (!existing) return new Response('Not Found', { status: 404 });
  deleteLama(id);
  return new Response(null, { status: 204 });
}

export async function PATCH(req: NextRequest) {
  // bulk import
  const body = await req.json();
  if (!Array.isArray(body)) return new Response('Bad Request', { status: 400 });
  const ids = importLamas(body.slice(0, 200));
  return Response.json({ imported: ids.length });
}
