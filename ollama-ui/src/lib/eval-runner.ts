/*
Runs an evaluation set: every prompt against every selected model, one
request at a time, recording each answer with the speed it was produced at.

Strictly sequential, and deliberately so. Ollama serves a limited number of
models concurrently (OLLAMA_NUM_PARALLEL, plus whatever fits in VRAM), so
firing everything at once would mostly produce queueing — and would make the
tokens/second figures meaningless, since they would be measured while other
generations competed for the same GPU. Comparing models is the entire point,
so the measurements have to be comparable.

Runs detached from the request that started it (see the eval run route), the
same way a chat generation does: a set of ten prompts across four models is
many minutes of work, and closing the tab must not abandon it.
*/
import { finishEvalRun, recordBenchmarkRun, recordEvalResult } from '@/lib/db';

interface OllamaChatResponse {
  message?: { content?: string };
  error?: string;
  eval_count?: number;
  eval_duration?: number; // nanoseconds
  prompt_eval_count?: number;
}

// Generous: a cold model load is counted in wall-clock time but not in the
// tokens/second figure, which Ollama reports from generation alone.
const PER_PROMPT_TIMEOUT_MS = 10 * 60_000;

export async function runEvaluation(params: {
  runId: string;
  base: string;
  models: string[];
  prompts: string[];
}): Promise<void> {
  const { runId, base, models, prompts } = params;
  try {
    for (const [promptIndex, prompt] of prompts.entries()) {
      for (const model of models) {
        const startedAt = Date.now();
        try {
          const upstream = await fetch(`${base}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(PER_PROMPT_TIMEOUT_MS),
            body: JSON.stringify({
              model,
              messages: [{ role: 'user', content: prompt }],
              stream: false,
              // No tools and no memory: the comparison is of the models
              // themselves, and letting one of them search the web while
              // another doesn't would measure the tool, not the model.
              think: false,
            }),
          });
          if (!upstream.ok) {
            const text = await upstream.text().catch(() => '');
            recordEvalResult({
              runId,
              promptIndex,
              prompt,
              model,
              content: '',
              error: text || `Upstream error (${upstream.status})`,
              tokensPerSecond: null,
              durationMs: Date.now() - startedAt,
            });
            continue;
          }
          const data = (await upstream.json()) as OllamaChatResponse;
          const tokensPerSecond =
            data.eval_count && data.eval_duration
              ? Math.round((data.eval_count / (data.eval_duration / 1e9)) * 10) / 10
              : null;
          recordEvalResult({
            runId,
            promptIndex,
            prompt,
            model,
            content: data.message?.content ?? '',
            error: data.error ?? null,
            tokensPerSecond,
            durationMs: Date.now() - startedAt,
          });
          // Feed the existing speed history too, so the benchmark trend
          // chart reflects these runs rather than treating them as a
          // separate universe.
          if (tokensPerSecond !== null) {
            recordBenchmarkRun({
              model,
              source: 'manual',
              promptTokens: data.prompt_eval_count,
              completionTokens: data.eval_count,
              tokensPerSecond,
            });
          }
        } catch (e) {
          // One model failing (not pulled, out of memory, timed out) must
          // not abandon the rest of the matrix — the row simply records why.
          recordEvalResult({
            runId,
            promptIndex,
            prompt,
            model,
            content: '',
            error: e instanceof Error ? e.message : String(e),
            tokensPerSecond: null,
            durationMs: Date.now() - startedAt,
          });
        }
      }
    }
  } finally {
    // Always marks the run finished, so a crash mid-matrix leaves a run that
    // is honestly "done, with gaps" rather than one stuck on "running"
    // forever.
    finishEvalRun(runId);
  }
}
