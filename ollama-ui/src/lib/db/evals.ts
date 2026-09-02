// Saved prompt sets, the runs made from them, and their scored results.
import { db } from './connection';
import { safeUuid } from '@/lib/utils';

// --- Evaluation sets ---

export interface EvalSetRow {
  id: string;
  name: string;
  prompts: string[];
  created_at: number;
  updated_at: number;
}

export interface EvalResultRow {
  id: string;
  runId: string;
  promptIndex: number;
  prompt: string;
  model: string;
  content: string;
  error: string | null;
  tokensPerSecond: number | null;
  durationMs: number | null;
  rating: number | null;
  createdAt: number;
}

export interface EvalRunRow {
  id: string;
  setId: string;
  setName: string;
  models: string[];
  status: 'running' | 'done';
  created_at: number;
  finished_at: number | null;
}

export function listEvalSets(): EvalSetRow[] {
  const rows = db
    .prepare('SELECT * FROM eval_sets ORDER BY updated_at DESC')
    .all() as unknown as Array<{
    id: string;
    name: string;
    prompts: string;
    created_at: number;
    updated_at: number;
  }>;
  return rows.map((r) => ({ ...r, prompts: JSON.parse(r.prompts) as string[] }));
}

export function getEvalSet(id: string): EvalSetRow | undefined {
  return listEvalSets().find((s) => s.id === id);
}

export function upsertEvalSet(data: { id?: string; name: string; prompts: string[] }): EvalSetRow {
  const now = Date.now();
  const existing = data.id ? getEvalSet(data.id) : undefined;
  const row: EvalSetRow = {
    id: existing?.id ?? safeUuid(),
    name: data.name,
    prompts: data.prompts,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  db.prepare(
    'INSERT OR REPLACE INTO eval_sets (id, name, prompts, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(row.id, row.name, JSON.stringify(row.prompts), row.created_at, row.updated_at);
  return row;
}

export function deleteEvalSet(id: string): void {
  db.prepare('DELETE FROM eval_sets WHERE id = ?').run(id);
}

export function createEvalRun(data: {
  setId: string;
  setName: string;
  models: string[];
}): EvalRunRow {
  const now = Date.now();
  const row: EvalRunRow = {
    id: safeUuid(),
    setId: data.setId,
    setName: data.setName,
    models: data.models,
    status: 'running',
    created_at: now,
    finished_at: null,
  };
  db.prepare(
    'INSERT INTO eval_runs (id, set_id, set_name, models, status, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.setId,
    row.setName,
    JSON.stringify(row.models),
    row.status,
    row.created_at,
    null,
  );
  return row;
}

export function finishEvalRun(id: string): void {
  db.prepare("UPDATE eval_runs SET status = 'done', finished_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

export function listEvalRuns(limit = 25): EvalRunRow[] {
  const rows = db
    .prepare('SELECT * FROM eval_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit) as unknown as Array<{
    id: string;
    set_id: string;
    set_name: string;
    models: string;
    status: string;
    created_at: number;
    finished_at: number | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    setId: r.set_id,
    setName: r.set_name,
    models: JSON.parse(r.models) as string[],
    status: r.status === 'done' ? 'done' : 'running',
    created_at: r.created_at,
    finished_at: r.finished_at,
  }));
}

export function getEvalRun(id: string): EvalRunRow | undefined {
  return listEvalRuns(1000).find((r) => r.id === id);
}

export function recordEvalResult(data: Omit<EvalResultRow, 'id' | 'createdAt' | 'rating'>): void {
  db.prepare(
    `INSERT INTO eval_results
       (id, run_id, prompt_index, prompt, model, content, error, tokens_per_second, duration_ms, rating, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    safeUuid(),
    data.runId,
    data.promptIndex,
    data.prompt,
    data.model,
    data.content,
    data.error,
    data.tokensPerSecond,
    data.durationMs,
    Date.now(),
  );
}

export function listEvalResults(runId: string): EvalResultRow[] {
  const rows = db
    .prepare('SELECT * FROM eval_results WHERE run_id = ? ORDER BY prompt_index ASC, model ASC')
    .all(runId) as unknown as Array<{
    id: string;
    run_id: string;
    prompt_index: number;
    prompt: string;
    model: string;
    content: string;
    error: string | null;
    tokens_per_second: number | null;
    duration_ms: number | null;
    rating: number | null;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    promptIndex: r.prompt_index,
    prompt: r.prompt,
    model: r.model,
    content: r.content,
    error: r.error,
    tokensPerSecond: r.tokens_per_second,
    durationMs: r.duration_ms,
    rating: r.rating,
    createdAt: r.created_at,
  }));
}

// Scores one answer. null clears a rating, which matters: "not judged yet"
// is a real state and must be reachable again after a misclick.
export function rateEvalResult(id: string, rating: number | null): boolean {
  const existing = db.prepare('SELECT id FROM eval_results WHERE id = ?').get(id);
  if (!existing) return false;
  db.prepare('UPDATE eval_results SET rating = ? WHERE id = ?').run(rating, id);
  return true;
}
