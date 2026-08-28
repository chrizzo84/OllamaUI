import { listBenchmarkRuns, type BenchmarkRunRow } from '@/lib/db';

export interface BenchmarkSummary {
  model: string;
  samples: number;
  avgTokensPerSecond: number;
  minTokensPerSecond: number;
  maxTokensPerSecond: number;
  lastRunAt: number;
  chatSamples: number;
  manualSamples: number;
}

// JS-computed aggregation rather than SQL — the data volume here (a personal
// self-hosted instance's own chat/benchmark history) never gets large enough
// for that to matter, and it keeps db.ts's listBenchmarkRuns a plain,
// reusable list query.
function summarize(runs: BenchmarkRunRow[]): BenchmarkSummary[] {
  const byModel = new Map<string, BenchmarkRunRow[]>();
  for (const r of runs) {
    if (r.tokensPerSecond == null) continue;
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  return [...byModel.entries()]
    .map(([model, list]) => {
      const speeds = list.map((r) => r.tokensPerSecond!);
      return {
        model,
        samples: list.length,
        avgTokensPerSecond:
          Math.round((speeds.reduce((a, b) => a + b, 0) / speeds.length) * 10) / 10,
        minTokensPerSecond: Math.min(...speeds),
        maxTokensPerSecond: Math.max(...speeds),
        lastRunAt: Math.max(...list.map((r) => r.created_at)),
        chatSamples: list.filter((r) => r.source === 'chat').length,
        manualSamples: list.filter((r) => r.source === 'manual').length,
      };
    })
    .sort((a, b) => b.avgTokensPerSecond - a.avgTokensPerSecond);
}

export async function GET() {
  const runs = listBenchmarkRuns({ limit: 500 });
  return Response.json({
    runs: runs.map((r) => ({
      id: r.id,
      model: r.model,
      source: r.source,
      tokensPerSecond: r.tokensPerSecond,
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      createdAt: r.created_at,
    })),
    summary: summarize(runs),
  });
}
