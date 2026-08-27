import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { performWebSearch } from '@/lib/web-search';
import { safeUuid } from '@/lib/utils';
import {
  createJob,
  publish,
  settleJob,
  updateSnapshot,
  createJobEventStream,
  countOtherRunningForModel,
  type Job,
} from '@/lib/generation-jobs';
import { upsertMessages, persistFinalAssistantMessage } from '@/lib/chat-persistence';
import type { ChatMessage, TraceEvent } from '@/store/chat';
import type { ChatStats } from '@/lib/chat-stream';

interface OllamaToolCall {
  function?: { name?: string; arguments?: unknown };
}

interface UpstreamMessageChunk {
  message?: { content?: string; thinking?: string; tool_calls?: OllamaToolCall[] };
  response?: string; // fallback style
  done?: boolean;
  error?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number; // nanoseconds
  [key: string]: unknown;
}

interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  name?: string;
}

export const runtime = 'nodejs';

// Bounds how many times the model may call tools in a single request before
// we force a final answer, so a confused model can't loop forever. The last
// iteration always omits `tools` from the upstream request (see below), so
// the model gets one guaranteed tool-free turn to write its actual answer.
const MAX_TOOL_ITERATIONS = 6;

// Idle timeout applied ONLY once Ollama has already sent at least one chunk
// for the current turn — catches a generation that genuinely freezes
// mid-stream. Deliberately NOT applied to the wait for that first chunk (see
// createIdleAbort below): that wait can legitimately take a long time for
// reasons that are not a failure at all — a cold local model load, or a
// second parallel chat queued behind another request Ollama is already
// serving for the same model (Ollama itself decides how many it runs
// concurrently per model via OLLAMA_NUM_PARALLEL plus whatever fits in VRAM,
// not something this app controls; by default that's often 1). A generation
// job runs decoupled from the browser tab specifically so it can outlive
// that kind of wait — timing it out here would turn perfectly normal
// queueing into a hard, user-visible failure, which must never happen.
const OLLAMA_IDLE_TIMEOUT_MS = 20 * 60_000;

// An AbortController that fires if `kick()` isn't called again within `ms`
// of the PREVIOUS `kick()` — instead of firing at a fixed deadline — so it
// only trips on genuine inactivity between chunks. Crucially, the timer is
// not armed until `kick()` is called for the first time: the wait for that
// very first chunk (fetch() resolving, then the first successful body read)
// is left completely unbounded by this mechanism. A real connection failure
// during that wait still surfaces on its own, via fetch()/read() throwing —
// this only guards against silent stalls once data has started flowing.
function createIdleAbort(ms: number) {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };
  return {
    signal: controller.signal,
    kick: arm,
    clear: () => {
      if (timer) clearTimeout(timer);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the web via SearXNG for up-to-date information (current events, facts beyond the training cutoff, prices, etc.). Returns a list of results with title, url and snippet.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query.' },
        max_results: {
          type: 'integer',
          description: 'Maximum number of results to return (default 5, max 15).',
        },
      },
      required: ['query'],
    },
  },
};

const CURRENT_DATE_TOOL = {
  type: 'function',
  function: {
    name: 'get_current_date',
    description:
      "Returns the current date, weekday and time. Use this whenever you need to know what 'today' is, or reason about relative dates (this week, tomorrow, how long ago, etc.).",
    parameters: { type: 'object', properties: {} },
  },
};

const AVAILABLE_TOOLS = [WEB_SEARCH_TOOL, CURRENT_DATE_TOOL];

async function executeTool(
  name: string,
  args: unknown,
  searxngTemplate: string | null,
): Promise<{ result?: unknown; error?: string }> {
  if (name === 'get_current_date') {
    const now = new Date();
    return {
      result: {
        iso: now.toISOString(),
        date: now.toLocaleDateString('en-CA'), // YYYY-MM-DD
        weekday: now.toLocaleDateString('en-US', { weekday: 'long' }),
        time: now.toLocaleTimeString('en-GB'),
      },
    };
  }
  if (name !== 'web_search') return { error: `Unknown tool: ${name}` };
  const a = (args && typeof args === 'object' ? args : {}) as {
    query?: unknown;
    max_results?: unknown;
  };
  if (typeof a.query !== 'string' || !a.query.trim()) {
    return { error: 'Missing required "query" argument' };
  }
  try {
    const result = await performWebSearch({
      query: a.query,
      max: typeof a.max_results === 'number' ? a.max_results : undefined,
      endpointTemplate: searxngTemplate,
    });
    return { result };
  } catch (e: unknown) {
    return { error: e instanceof Error ? e.message : 'web_search failed' };
  }
}

interface GenerationParams {
  base: string;
  model: string;
  messages: ChatMessageIn[];
  think: boolean;
  options: unknown;
  toolsEnabled: boolean;
  searxngTemplate: string | null;
}

// Runs the actual Ollama tool-calling loop independently of any HTTP
// response — this is what lets generation survive the browser tab closing.
// Progress is published to the job's subscribers (an open tab tails it live,
// exactly like the old direct-to-response `emit()` did), and the final
// result is persisted to the DB directly, regardless of whether anyone is
// still listening. Never throws past its own catch-alls; every exit path
// settles the job and persists something.
async function runGeneration(job: Job, params: GenerationParams): Promise<void> {
  const { base, model, think, options, toolsEnabled, searxngTemplate } = params;
  const messages: ChatMessageIn[] = params.messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.name ? { name: m.name } : {}),
  }));

  // Heads-up only, checked once at the start — not a promise either way.
  // Whether this job actually runs alongside the other one is entirely up to
  // Ollama (OLLAMA_NUM_PARALLEL plus whether the model's KV cache fits
  // multiple parallel slots in VRAM); we have no visibility into that. This
  // just tells the client "something else is already using this model right
  // now", so a long silent wait reads as expected instead of looking stuck.
  const aheadCount = countOtherRunningForModel(model, job.id);
  if (aheadCount > 0) {
    publish(job.id, { queued: { aheadCount } });
  }

  let contentAggregated = '';
  let thinkingAggregated = '';
  let completionTokensTotal = 0;
  let evalDurationTotalNs = 0;
  let lastPromptTokens: number | undefined;
  const trace: TraceEvent[] = [];
  let openThinkingId: string | null = null;

  function buildStats(): ChatStats {
    return {
      promptTokens: lastPromptTokens,
      completionTokens: completionTokensTotal || undefined,
      tokensPerSecond:
        evalDurationTotalNs > 0
          ? Math.round((completionTokensTotal / (evalDurationTotalNs / 1e9)) * 10) / 10
          : undefined,
    };
  }

  // Keeps the job's catch-up snapshot current so a tab that reconnects mid-
  // generation (GET /api/chat/jobs/[id]) sees where things stand right now,
  // instead of an empty message until the next live delta happens to arrive.
  function syncSnapshot() {
    updateSnapshot(job.id, {
      content: contentAggregated,
      thinking: thinkingAggregated || undefined,
      trace: [...trace],
    });
  }

  async function finishDone(status: 'done' | 'aborted') {
    const stats = buildStats();
    publish(job.id, {
      done: true,
      model,
      content: contentAggregated,
      thinking: thinkingAggregated || undefined,
      stats,
    });
    if (!contentAggregated && !thinkingAggregated && status === 'done') {
      publish(job.id, { info: 'empty response', model });
    }
    settleJob(job.id, status);
    persistFinalAssistantMessage(job.sessionId, job.id, {
      content: contentAggregated,
      trace,
      stats,
    });
    // Always last: tells an attached response stream it's safe to close now
    // (see the POST handler's subscriber).
    publish(job.id, { streamEnd: true });
  }

  function finishError(message: string) {
    publish(job.id, { error: message });
    settleJob(job.id, 'error');
    persistFinalAssistantMessage(job.sessionId, job.id, {
      content: '[Error] ' + message,
      trace,
      stats: buildStats(),
    });
    publish(job.id, { streamEnd: true });
  }

  for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
    if (job.abortController.signal.aborted) {
      await finishDone('aborted');
      return;
    }
    const isLastIteration = iter === MAX_TOOL_ITERATIONS - 1;
    // Idle timeout: aborts if Ollama neither responds nor emits a body chunk
    // for this long, instead of hanging the job forever. Reset on every
    // chunk, so a slow but steady generation (or a long cold model load) is
    // never cut off. Combined with the job's own AbortController so an
    // explicit Stop (see /api/chat/jobs/[id]) can also cancel this fetch —
    // but a client merely disconnecting (tab closed) must NOT trip this;
    // that's handled entirely by not tying this loop to the response stream.
    const idle = createIdleAbort(OLLAMA_IDLE_TIMEOUT_MS);
    const upstreamSignal = AbortSignal.any([idle.signal, job.abortController.signal]);
    let upstream: Response;
    try {
      upstream = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: upstreamSignal,
        body: JSON.stringify({
          model,
          messages,
          stream: true,
          think,
          ...(options ? { options } : {}),
          // Omit tools on the final iteration so the model can't get stuck
          // requesting one more tool call that we'd have to drop; it's
          // forced to answer in plain text instead.
          ...(toolsEnabled && !isLastIteration ? { tools: AVAILABLE_TOOLS } : {}),
        }),
      });
    } catch (e) {
      // Can't be an idle timeout — that timer isn't armed until after the
      // first successful body read (see createIdleAbort), which is later
      // than this fetch() call. A genuine connection failure (host down,
      // DNS, network) surfaces here on its own.
      idle.clear();
      if (job.abortController.signal.aborted) {
        await finishDone('aborted');
        return;
      }
      finishError(e instanceof Error ? e.message : 'Failed to reach Ollama host');
      return;
    }

    if (!upstream.ok || !upstream.body) {
      idle.clear();
      const txt = await upstream.text().catch(() => '');
      finishError(txt || `Upstream error (${upstream.status})`);
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let turnContent = '';
    let turnToolCalls: OllamaToolCall[] = [];
    let turnPromptTokens: number | undefined;
    let turnEvalCount = 0;
    let turnEvalDurationNs = 0;
    let fatalError = false;
    let fatalErrorMessage = '';

    function handleParsed(parsed: UpstreamMessageChunk) {
      if (typeof parsed.prompt_eval_count === 'number') turnPromptTokens = parsed.prompt_eval_count;
      if (typeof parsed.eval_count === 'number') turnEvalCount = parsed.eval_count;
      if (typeof parsed.eval_duration === 'number') turnEvalDurationNs = parsed.eval_duration;
      if (parsed.message) {
        const thinkDelta = parsed.message.thinking ?? '';
        const contentDelta = parsed.message.content ?? '';
        if (thinkDelta) {
          thinkingAggregated += thinkDelta;
          if (openThinkingId) {
            const entry = trace.find((t) => t.id === openThinkingId);
            if (entry && entry.type === 'thinking') entry.text += thinkDelta;
          } else {
            const id = safeUuid();
            openThinkingId = id;
            trace.push({ type: 'thinking', id, text: thinkDelta });
          }
          publish(job.id, { thinking: thinkDelta, model });
        }
        if (contentDelta) {
          turnContent += contentDelta;
          contentAggregated += contentDelta;
          publish(job.id, { token: contentDelta, model });
        }
        if (parsed.message.tool_calls?.length) {
          turnToolCalls = parsed.message.tool_calls;
        }
      } else if (typeof parsed.response === 'string') {
        // fallback: generate-style (delta)
        turnContent += parsed.response;
        contentAggregated += parsed.response;
        publish(job.id, { token: parsed.response, model });
      } else if (typeof parsed.error === 'string') {
        fatalError = true;
        fatalErrorMessage = parsed.error;
      } else {
        publish(job.id, parsed);
      }
      syncSnapshot();
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        idle.kick();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            handleParsed(JSON.parse(line) as UpstreamMessageChunk);
          } catch {
            publish(job.id, { raw: line });
          }
          if (fatalError) break;
        }
        if (fatalError) break;
      }
      if (!fatalError && buffer.trim()) {
        try {
          handleParsed(JSON.parse(buffer.trim()) as UpstreamMessageChunk);
        } catch {
          publish(job.id, { raw: buffer.trim() });
        }
      }
    } catch (e) {
      idle.clear();
      if (job.abortController.signal.aborted) {
        await finishDone('aborted');
        return;
      }
      finishError(
        idle.timedOut
          ? `Ollama stopped responding (idle for ${OLLAMA_IDLE_TIMEOUT_MS / 1000}s)`
          : e instanceof Error
            ? e.message
            : 'Stream read failed',
      );
      return;
    } finally {
      idle.clear();
    }

    if (fatalError) {
      finishError(fatalErrorMessage);
      return;
    }

    completionTokensTotal += turnEvalCount;
    evalDurationTotalNs += turnEvalDurationNs;
    if (turnPromptTokens !== undefined) lastPromptTokens = turnPromptTokens;

    if (job.abortController.signal.aborted) {
      await finishDone('aborted');
      return;
    }

    const validToolCalls = turnToolCalls.filter((c) => c.function?.name);
    if (validToolCalls.length && toolsEnabled && !isLastIteration) {
      messages.push({ role: 'assistant', content: turnContent, tool_calls: validToolCalls });
      openThinkingId = null;
      for (const call of validToolCalls) {
        const name = call.function!.name!;
        const args = call.function!.arguments;
        const id = safeUuid();
        trace.push({ type: 'tool', id, name, arguments: args });
        publish(job.id, { toolCall: { id, name, arguments: args } });
        syncSnapshot();
        const { result, error } = await executeTool(name, args, searxngTemplate);
        const traceIdx = trace.findIndex((t) => t.id === id);
        if (traceIdx !== -1) {
          const existing = trace[traceIdx];
          if (existing.type === 'tool') trace[traceIdx] = { ...existing, result, error };
        }
        publish(
          job.id,
          error ? { toolResult: { id, name, error } } : { toolResult: { id, name, result } },
        );
        syncSnapshot();
        messages.push({
          role: 'tool',
          content: JSON.stringify(error ? { error } : result),
          name,
        });
      }
      continue; // next turn, no client-facing `done` yet
    }

    await finishDone('done');
    return;
  }

  // Safety net: model kept calling tools past the iteration cap.
  await finishDone('done');
}

/*
POST body: {
  model: string, messages: {...}[], think?: boolean, options?: object,
  toolsEnabled?: boolean, sessionId: string, column?: 'A'|'B',
  userMessage: ChatMessage, assistantMessage: ChatMessage,
}
Header: x-searxng-endpoint-template (optional, forwarded to the web_search tool)

Starts a server-side generation job (src/lib/generation-jobs.ts) that runs
independently of this HTTP connection, then returns a ReadableStream that
tails the job's events as NDJSON — identical wire format to before. If the
client disconnects (tab closed), the stream's `cancel()` only unsubscribes;
the job keeps running and persists its result directly to the DB. Explicit
cancellation goes through DELETE /api/chat/jobs/[id] instead.
*/
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    const clientMessages: ChatMessageIn[] = Array.isArray(body.messages) ? body.messages : [];
    const think = body.think === true; // only enable if client explicitly requests it
    const options = typeof body.options === 'object' && body.options ? body.options : undefined;
    const toolsEnabled = body.toolsEnabled === true;
    const searxngTemplate = req.headers.get('x-searxng-endpoint-template');
    const sessionId = (body.sessionId as string | undefined)?.trim();
    const column: 'A' | 'B' = body.column === 'B' ? 'B' : 'A';
    const userMessage = body.userMessage as ChatMessage | undefined;
    const assistantMessage = body.assistantMessage as ChatMessage | undefined;

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model' }), { status: 400 });
    }
    if (!sessionId || !assistantMessage?.id) {
      return new Response(JSON.stringify({ error: 'Missing sessionId or assistantMessage' }), {
        status: 400,
      });
    }
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Durably write the user message + empty assistant placeholder BEFORE
    // touching Ollama at all — this is what makes closing the tab safe even
    // immediately after hitting send, not just mid-stream. Previously this
    // was a client-side, unawaited PATCH that a fast tab-close could lose.
    const toUpsert = userMessage?.id ? [userMessage, assistantMessage] : [assistantMessage];
    const ok = upsertMessages(sessionId, toUpsert);
    if (!ok) {
      return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 });
    }

    // Creating the job before building the event stream (rather than after)
    // matters: createJobEventStream subscribes synchronously, and
    // runGeneration is only kicked off below, after that subscription
    // exists — so no event can ever be published before something is
    // listening for it.
    const job = createJob(assistantMessage.id, { sessionId, column, model });
    const transformed = createJobEventStream(job.id)!; // job was just created above, always found

    // Fire-and-forget: NOT awaited, so it keeps running after this handler
    // returns and even after the response stream above is torn down. The
    // .catch is a last-resort net — everything inside runGeneration already
    // settles the job and persists on every normal exit path, but an
    // unexpected throw here would otherwise become an unhandled rejection in
    // this long-running process instead of a contained per-request failure.
    void runGeneration(job, {
      base,
      model,
      messages: clientMessages,
      think,
      options,
      toolsEnabled,
      searxngTemplate,
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      publish(job.id, { error: message });
      settleJob(job.id, 'error');
      persistFinalAssistantMessage(sessionId, job.id, { content: '[Error] ' + message });
      publish(job.id, { streamEnd: true });
    });

    return new Response(transformed, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Chat failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
