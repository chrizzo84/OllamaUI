import { NextRequest } from 'next/server';
import { rateEvalResult } from '@/lib/db';

export const runtime = 'nodejs';

/*
PATCH { id, rating } — score one answer, or clear the score with null.

Ratings are the half of the comparison a benchmark can't give you: tokens
per second is measurable, "answered my question well" is a judgement, and it
has to be recorded next to the answer it belongs to for the comparison to
mean anything later.
*/
export async function PATCH(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return Response.json({ error: 'id is required' }, { status: 400 });

  const rating =
    body.rating === null ? null : typeof body.rating === 'number' ? Math.round(body.rating) : NaN;
  if (rating !== null && (Number.isNaN(rating) || rating < 1 || rating > 5)) {
    return Response.json({ error: 'rating must be 1-5, or null to clear it' }, { status: 400 });
  }
  if (!rateEvalResult(id, rating)) {
    return Response.json({ error: 'No such result' }, { status: 404 });
  }
  return Response.json({ ok: true });
}
