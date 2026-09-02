import { NextRequest } from 'next/server';
import { getEvalRun, listEvalResults } from '@/lib/db';

export const runtime = 'nodejs';

// One run with everything recorded so far — results appear as the matrix
// fills in, which is what makes polling this while it runs useful.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = getEvalRun(id);
  if (!run) return new Response('Not Found', { status: 404 });
  return Response.json({ run, results: listEvalResults(id) });
}
