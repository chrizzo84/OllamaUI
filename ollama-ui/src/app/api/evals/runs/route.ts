import { NextRequest } from 'next/server';
import { createEvalRun, getEvalSet, listEvalRuns } from '@/lib/db';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { runEvaluation } from '@/lib/eval-runner';

export const runtime = 'nodejs';

export async function GET() {
  return Response.json({ runs: listEvalRuns() });
}

/*
Starts a run and returns immediately with its id.

The work is intentionally not awaited: a set of prompts across several local
models takes minutes, and it must survive the tab that started it — the same
reasoning as chat generation jobs (src/lib/generation-jobs.ts). Progress is
read by polling the run, whose results appear row by row as they land.
*/
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const setId = typeof body.setId === 'string' ? body.setId : '';
  const models = Array.isArray(body.models)
    ? body.models.filter((m: unknown): m is string => typeof m === 'string' && !!m.trim())
    : [];

  const set = setId ? getEvalSet(setId) : undefined;
  if (!set) return Response.json({ error: 'No such evaluation set' }, { status: 404 });
  if (models.length === 0) {
    return Response.json({ error: 'Pick at least one model to compare.' }, { status: 400 });
  }

  const base = resolveOllamaHostServer();
  if (!base) {
    return Response.json({ error: 'No host configured', code: 'NO_HOST' }, { status: 428 });
  }

  const run = createEvalRun({ setId: set.id, setName: set.name, models });
  void runEvaluation({ runId: run.id, base, models, prompts: set.prompts }).catch((e) => {
    // runEvaluation already records per-prompt failures and always marks the
    // run finished; this is the last-resort net so an unexpected throw
    // doesn't become an unhandled rejection in a long-running process.
    console.error('[evals] run failed:', e);
  });
  return Response.json({ run });
}
