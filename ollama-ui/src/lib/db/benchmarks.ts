// Per-model speed history.
import { db } from './connection';
import { safeUuid } from '@/lib/utils';

// --- Benchmark runs (per-model speed history, for the /benchmarks page) ---

export interface BenchmarkRunRow {
  id: string;
  model: string;
  source: 'chat' | 'manual';
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  created_at: number;
}

interface BenchmarkRunDbRow {
  id: string;
  model: string;
  source: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  tokens_per_second: number | null;
  created_at: number;
}

function rowToBenchmarkRun(r: BenchmarkRunDbRow): BenchmarkRunRow {
  return {
    id: r.id,
    model: r.model,
    source: r.source === 'manual' ? 'manual' : 'chat',
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    tokensPerSecond: r.tokens_per_second,
    created_at: r.created_at,
  };
}

export function recordBenchmarkRun(data: {
  model: string;
  source: 'chat' | 'manual';
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
}): void {
  db.prepare(
    'INSERT INTO benchmark_runs (id, model, source, prompt_tokens, completion_tokens, tokens_per_second, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    safeUuid(),
    data.model,
    data.source,
    data.promptTokens ?? null,
    data.completionTokens ?? null,
    data.tokensPerSecond ?? null,
    Date.now(),
  );
}

export function listBenchmarkRuns(opts: { limit?: number } = {}): BenchmarkRunRow[] {
  const limit = opts.limit ?? 500;
  const rows = db
    .prepare('SELECT * FROM benchmark_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit);
  return (rows as unknown as BenchmarkRunDbRow[]).map(rowToBenchmarkRun);
}
