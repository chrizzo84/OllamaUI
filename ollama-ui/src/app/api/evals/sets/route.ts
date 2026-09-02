import { NextRequest } from 'next/server';
import { listEvalSets, upsertEvalSet, deleteEvalSet } from '@/lib/db';

export const runtime = 'nodejs';

// The saved prompt sets. A set is just a name and a list of prompts — the
// value is in reusing the *same* prompts across models and across time, so
// a new model can be measured against the questions you already care about.

export async function GET() {
  return Response.json({ sets: listEvalSets() });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const prompts = Array.isArray(body.prompts)
    ? body.prompts.filter((p: unknown): p is string => typeof p === 'string' && !!p.trim())
    : [];
  if (!name) return Response.json({ error: 'Name is required.' }, { status: 400 });
  if (prompts.length === 0) {
    return Response.json({ error: 'A set needs at least one prompt.' }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id : undefined;
  return Response.json({ set: upsertEvalSet({ id, name, prompts }) });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });
  deleteEvalSet(id);
  return new Response(null, { status: 204 });
}
