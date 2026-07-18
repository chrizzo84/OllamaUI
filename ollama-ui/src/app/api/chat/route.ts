import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { performWebSearch } from '@/lib/web-search';
import { safeUuid } from '@/lib/utils';

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

export interface ChatStats {
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
}

interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  name?: string;
}

export const runtime = 'nodejs';

// Bounds how many times the model may call tools in a single request before
// we force a final answer, so a confused model can't loop forever.
const MAX_TOOL_ITERATIONS = 4;

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

/*
POST body: { model: string, messages: {...}[], stream?: boolean, toolsEnabled?: boolean }
Header: x-searxng-endpoint-template (optional, forwarded to the web_search tool)
Proxy to Ollama /api/chat with streaming, normalizing output to NDJSON lines.
When toolsEnabled, runs a bounded tool-calling loop: if the model requests
web_search, the tool is executed server-side and its result is fed back to
the model as a `tool` message before continuing the conversation.
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
    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model' }), { status: 400 });
    }
    const base = resolveOllamaHostServer(req);
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Mutable conversation, grows with assistant tool-call turns + tool results.
    const messages: ChatMessageIn[] = clientMessages.map((m) => ({
      role: m.role,
      content: m.content,
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.name ? { name: m.name } : {}),
    }));

    let contentAggregated = '';
    let thinkingAggregated = '';
    let completionTokensTotal = 0;
    let evalDurationTotalNs = 0;
    let lastPromptTokens: number | undefined;

    const transformed = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        function emit(obj: unknown) {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        }

        for (let iter = 0; iter < MAX_TOOL_ITERATIONS; iter++) {
          let upstream: Response;
          try {
            upstream = await fetch(`${base}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                messages,
                stream: true,
                think,
                ...(options ? { options } : {}),
                ...(toolsEnabled ? { tools: AVAILABLE_TOOLS } : {}),
              }),
            });
          } catch (e) {
            emit({ error: e instanceof Error ? e.message : 'Failed to reach Ollama host' });
            controller.close();
            return;
          }

          if (!upstream.ok || !upstream.body) {
            const txt = await upstream.text().catch(() => '');
            emit({ error: txt || `Upstream error (${upstream.status})` });
            controller.close();
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

          function handleParsed(parsed: UpstreamMessageChunk) {
            if (typeof parsed.prompt_eval_count === 'number')
              turnPromptTokens = parsed.prompt_eval_count;
            if (typeof parsed.eval_count === 'number') turnEvalCount = parsed.eval_count;
            if (typeof parsed.eval_duration === 'number') turnEvalDurationNs = parsed.eval_duration;
            if (parsed.message) {
              const thinkDelta = parsed.message.thinking ?? '';
              const contentDelta = parsed.message.content ?? '';
              if (thinkDelta) {
                thinkingAggregated += thinkDelta;
                emit({ thinking: thinkDelta, model });
              }
              if (contentDelta) {
                turnContent += contentDelta;
                contentAggregated += contentDelta;
                emit({ token: contentDelta, model });
              }
              if (parsed.message.tool_calls?.length) {
                turnToolCalls = parsed.message.tool_calls;
              }
            } else if (typeof parsed.response === 'string') {
              // fallback: generate-style (delta)
              turnContent += parsed.response;
              contentAggregated += parsed.response;
              emit({ token: parsed.response, model });
            } else if (typeof parsed.error === 'string') {
              emit({ error: parsed.error });
              fatalError = true;
            } else {
              emit(parsed);
            }
          }

          while (true) {
            const { done, value } = await reader.read();
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
                emit({ raw: line });
              }
              if (fatalError) break;
            }
            if (fatalError) break;
          }
          if (!fatalError && buffer.trim()) {
            try {
              handleParsed(JSON.parse(buffer.trim()) as UpstreamMessageChunk);
            } catch {
              emit({ raw: buffer.trim() });
            }
          }

          if (fatalError) {
            controller.close();
            return;
          }

          completionTokensTotal += turnEvalCount;
          evalDurationTotalNs += turnEvalDurationNs;
          if (turnPromptTokens !== undefined) lastPromptTokens = turnPromptTokens;

          const validToolCalls = turnToolCalls.filter((c) => c.function?.name);
          if (validToolCalls.length && toolsEnabled && iter < MAX_TOOL_ITERATIONS - 1) {
            messages.push({ role: 'assistant', content: turnContent, tool_calls: validToolCalls });
            for (const call of validToolCalls) {
              const name = call.function!.name!;
              const args = call.function!.arguments;
              const id = safeUuid();
              emit({ toolCall: { id, name, arguments: args } });
              const { result, error } = await executeTool(name, args, searxngTemplate);
              emit(
                error ? { toolResult: { id, name, error } } : { toolResult: { id, name, result } },
              );
              messages.push({
                role: 'tool',
                content: JSON.stringify(error ? { error } : result),
                name,
              });
            }
            continue; // next turn, no client-facing `done` yet
          }

          emit({
            done: true,
            model,
            content: contentAggregated,
            thinking: thinkingAggregated || undefined,
            stats: buildStats(),
          });
          if (!contentAggregated && !thinkingAggregated) emit({ info: 'empty response', model });
          controller.close();
          return;
        }

        // Safety net: model kept calling tools past the iteration cap.
        emit({
          done: true,
          model,
          content: contentAggregated,
          thinking: thinkingAggregated || undefined,
          stats: buildStats(),
        });
        controller.close();

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
      },
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
