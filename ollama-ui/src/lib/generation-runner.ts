// The actual Ollama tool-calling generation loop, extracted out of
// src/app/api/chat/route.ts so it can be driven by more than one trigger:
// a real chat POST (route.ts) and a scheduled task (src/lib/scheduler.ts).
// Deliberately has no knowledge of NextRequest/Response — it only needs a
// Job (src/lib/generation-jobs.ts) and plain params, so it works identically
// whether the caller is an HTTP handler or a background timer tick.
import { performWebSearch } from '@/lib/web-search';
import { getWeather } from '@/lib/weather';
import { evaluateExpression } from '@/lib/calculator';
import { safeUuid, deriveSessionTitle } from '@/lib/utils';
import {
  publish,
  settleJob,
  updateSnapshot,
  countOtherRunningForModel,
  type Job,
} from '@/lib/generation-jobs';
import { persistFinalAssistantMessage } from '@/lib/chat-persistence';
import { extractDurableFacts, alreadySavedDuringReply } from '@/lib/memory-extract';
import {
  remember,
  isMemoryType,
  recallMemories,
  markMemoriesUsed,
  buildMemoryBlock,
  recordBenchmarkRun,
  createScheduledTask,
  listScheduledTasks,
  deleteScheduledTask,
  attachmentsAsBase64,
} from '@/lib/db';
import {
  callTool as callMcpTool,
  listAllTools,
  parseNamespacedToolName,
  toOllamaTool,
} from '@/lib/mcp';
import { listMcpServers } from '@/lib/mcp-settings';
import { computeNextRunAt, weekdayOf } from '@/lib/schedule-time';
import type { TraceEvent } from '@/store/chat';
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

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  name?: string;
  /*
  The stored trace of a past assistant reply, when this message was loaded
  from the database. Never sent upstream as-is — runGeneration expands its
  tool entries back into the assistant/tool message pair they came from
  (see replayToolTrace).
  */
  trace?: TraceEvent[];
  images?: string[]; // raw base64, no data: prefix — passed straight through to Ollama
  // Attachment ids, resolved to base64 `images` just before the upstream
  // request (see runGeneration). Set on messages loaded from the database.
  attachments?: string[];
}

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

const GET_WEATHER_TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description:
      'Get the current weather and a multi-day forecast for a location. Prefer this over web_search for weather questions — it returns structured, reliable forecast data (temperature, precipitation, conditions) instead of search snippets you would have to interpret yourself.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name (optionally with country), e.g. "Paris" or "Tokyo, Japan".',
        },
        days: {
          type: 'integer',
          description: 'Number of forecast days, 1-7 (default 3).',
        },
      },
      required: ['location'],
    },
  },
};

const CALCULATOR_TOOL = {
  type: 'function',
  function: {
    name: 'calculator',
    description:
      'Evaluate a basic arithmetic expression (+, -, *, /, %, ^, parentheses). Use this for any nontrivial calculation instead of computing it yourself, to avoid arithmetic mistakes.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The arithmetic expression to evaluate, e.g. "(12 + 5) * 3 / 2".',
        },
      },
      required: ['expression'],
    },
  },
};

const CREATE_REMINDER_TOOL = {
  type: 'function',
  function: {
    name: 'create_reminder',
    description:
      'Schedule a one-time reminder that fires at a specific future date/time, even if this chat is closed by then — it runs as a new chat message at that time, exactly like a normal reply, and can use tools if needed. Call get_current_date first if you need to work out a relative time like "tomorrow" or "in 2 hours". Only for a single future moment — for anything recurring (daily/weekly), use create_recurring_task instead.',
    parameters: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description:
            'What to do/say when the reminder fires, phrased as an instruction to yourself, e.g. "Remind the user to call the dentist."',
        },
        whenISO: {
          type: 'string',
          description:
            'The exact future date and time to fire, as an ISO 8601 datetime string, e.g. "2026-08-29T09:00:00".',
        },
      },
      required: ['message', 'whenISO'],
    },
  },
};

const CREATE_RECURRING_TASK_TOOL = {
  type: 'function',
  function: {
    name: 'create_recurring_task',
    description:
      'Schedule a prompt that runs automatically on a repeating schedule (e.g. "every weekday morning at 8, check the weather"), even if this chat is closed by then — each run lands as a new chat message, with tools and memory available, same as a normal reply. Same effect as adding it on the Scheduled page in the app. For a single one-off moment instead, use create_reminder.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Short label for this task, e.g. "Morning weather check".',
        },
        prompt: {
          type: 'string',
          description:
            'What to do/ask each time it runs, e.g. "Check today\'s weather in Munich and summarize it."',
        },
        timeOfDay: {
          type: 'string',
          description: 'Time of day to run, 24h "HH:MM" format (server-local), e.g. "08:00".',
        },
        daysOfWeek: {
          type: 'array',
          items: { type: 'integer' },
          description:
            'Days to run on, 0=Sunday..6=Saturday, e.g. [1,2,3,4,5] for weekdays, [0,1,2,3,4,5,6] for every day.',
        },
      },
      required: ['name', 'prompt', 'timeOfDay', 'daysOfWeek'],
    },
  },
};

const LIST_SCHEDULED_TASKS_TOOL = {
  type: 'function',
  function: {
    name: 'list_scheduled_tasks',
    description:
      "List every currently scheduled recurring task and pending one-off reminder, with each one's id, name and next run time. Call this before cancel_scheduled_task if you don't already know the exact id.",
    parameters: { type: 'object', properties: {} },
  },
};

const CANCEL_SCHEDULED_TASK_TOOL = {
  type: 'function',
  function: {
    name: 'cancel_scheduled_task',
    description:
      "Cancel (permanently delete) a scheduled recurring task or pending one-off reminder. Provide the exact id from list_scheduled_tasks, or a name/distinctive substring to match by if you don't have the id.",
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Exact task id, from list_scheduled_tasks.' },
        name: {
          type: 'string',
          description: 'Task name or a distinctive substring of it, used only if id is omitted.',
        },
      },
    },
  },
};

const REMEMBER_FACT_TOOL = {
  type: 'function',
  function: {
    name: 'remember_fact',
    /*
    Rewritten after measuring it: the previous wording, which led with "only
    use this for things worth remembering long-term", saved a plainly durable
    fact ("meine Kiste ist ein Mini-PC mit 32 GB RAM und einer Grafikkarte") in 1 of
    5 runs against a local 35B model, and never with the [[links]] it asked for.
    Naming the categories instead of warning against over-saving, and saying
    outright that a question can contain a fact, took that to 3 of 5, with
    links and a subject every time.

    Longer is not better here: a further revision that also forbade bracketing
    plain values dropped it back to 0 of 5. Every additional rule makes a
    small model more hesitant to call the tool at all, so what survives here
    is what measurably earned its place.
    */
    description:
      'Remember something about the user across conversations. Call this whenever they state something about themselves that will still be true next week — their name, their language, the hardware they own, the tools and services they run, what they are working on, how they want you to answer. A question can still contain such a fact: "reicht meine Grafikkarte?" states which card they own. Call it once per fact, so a message containing three facts means three calls. Do not save what is only true inside this conversation. Wrap the things the fact is about in [[double brackets]]: "hat eine [[Grafikkarte]] und 128 GB RAM in seinem [[Arbeitsrechner]]".',
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description:
            "The fact, one sentence, in the user's language, with [[links]] around the things it is about.",
        },
        type: {
          type: 'string',
          enum: ['identity', 'state', 'preference', 'episodic'],
          description:
            'identity: durable traits — name, age, language, hardware they own. state: their current situation, which will change. preference: how they want you to work. episodic: something that happened at a point in time.',
        },
        /*
        Asking for the subject outright rather than deriving it from the first
        link: without one a fact can never be replaced, and the stored
        "Der Nutzer heißt Alex und ist 30 Jahre alt" had no subject and
        no links at all, so nothing could ever supersede it. Models that skip
        the brackets still tend to fill in a plain field.
        */
        subject: {
          type: 'string',
          description:
            'What the fact is about, one to three words ("grafikkarte", "name", "arbeitsrechner"). A later fact with the same subject replaces this one, so give one whenever the fact could change.',
        },
        confidence: {
          type: 'number',
          description:
            'How sure you are, 0 to 1. Below 0.5 the fact is saved for review instead of being used — use that when you are inferring rather than being told.',
        },
      },
      required: ['fact'],
    },
  },
};

// remember_fact is gated by its own `memoryEnabled` flag, independent of
// `toolsEnabled` (web_search/get_current_date) — a user who wants memory but
// not web search, or vice versa, shouldn't have to enable both together.
//
// `excludeNames` drops specific tools by name — used when a one-off reminder
// fires (see scheduler.ts) to hide create_reminder itself. Without that, a
// model handling "this is the reminder, deliver it now" would still see
// create_reminder in its tool list and, despite the prompt saying otherwise,
// sometimes call it again instead of just answering (observed live in
// testing: llama3.1:8b did this on 2/2 runs, either leaking the resulting
// tool error into the visible reply or silently mis-calling the tool before
// recovering).
function buildBuiltinTools(
  toolsEnabled: boolean,
  memoryEnabled: boolean,
  excludeNames: string[] = [],
) {
  return [
    ...(toolsEnabled
      ? [
          WEB_SEARCH_TOOL,
          CURRENT_DATE_TOOL,
          GET_WEATHER_TOOL,
          CALCULATOR_TOOL,
          CREATE_REMINDER_TOOL,
          CREATE_RECURRING_TASK_TOOL,
          LIST_SCHEDULED_TASKS_TOOL,
          CANCEL_SCHEDULED_TASK_TOOL,
        ]
      : []),
    ...(memoryEnabled ? [REMEMBER_FACT_TOOL] : []),
  ].filter((t) => !excludeNames.includes(t.function.name));
}

/*
Everything the model may call this turn: the built-in tools above plus
whatever the configured MCP servers currently advertise.

MCP tools are only offered when tool calling is on at all — memory alone
(memoryEnabled without toolsEnabled) should not quietly pull in external
servers. A server that is unreachable contributes nothing and logs why;
listAllTools never throws, so one broken server cannot cost the user their
reply.
*/
async function buildTools(
  toolsEnabled: boolean,
  memoryEnabled: boolean,
  excludeNames: string[] = [],
) {
  const builtin = buildBuiltinTools(toolsEnabled, memoryEnabled, excludeNames);
  if (!toolsEnabled) return builtin;

  const servers = listMcpServers();
  if (servers.every((s) => !s.enabled)) return builtin;

  const perServer = await listAllTools(servers);
  const mcpTools = perServer.flatMap((entry) => {
    if (entry.error) {
      console.error(`[mcp:${entry.serverId}] unavailable: ${entry.error}`);
      return [];
    }
    return entry.tools.map((t) => toOllamaTool(entry.serverId, t));
  });
  return [...builtin, ...mcpTools.filter((t) => !excludeNames.includes(t.function.name))];
}

async function executeTool(
  name: string,
  args: unknown,
  searxngTemplate: string | null,
  sessionId: string,
  model: string,
): Promise<{ result?: unknown; error?: string }> {
  // Anything namespaced belongs to an MCP server, not to this file — see
  // namespacedToolName in src/lib/mcp.ts for the naming scheme.
  const mcp = parseNamespacedToolName(name);
  if (mcp) {
    return callMcpTool(listMcpServers(), mcp.serverId, mcp.toolName, args);
  }
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
  if (name === 'remember_fact') {
    const a = (args && typeof args === 'object' ? args : {}) as {
      fact?: unknown;
      type?: unknown;
      subject?: unknown;
      confidence?: unknown;
    };
    if (typeof a.fact !== 'string' || !a.fact.trim()) {
      return { error: 'Missing required "fact" argument' };
    }
    const stored = remember({
      content: a.fact.trim(),
      type: isMemoryType(a.type) ? a.type : undefined,
      // Undefined (not null) when absent, so remember() falls back to the
      // first [[link]] rather than storing a fact that can never be replaced.
      subject: typeof a.subject === 'string' && a.subject.trim() ? a.subject.trim() : undefined,
      confidence: typeof a.confidence === 'number' ? a.confidence : undefined,
      sourceSessionId: sessionId,
    });
    /*
    The result says what actually happened, because all three outcomes are
    things the model should know and would otherwise guess at: a duplicate
    means "you already knew this, stop saving it again", a replacement means
    the older fact is no longer in play, and a draft means the fact is NOT in
    use yet. Answering a bare `{saved: true}` to a call that quietly changed
    the store is how a model ends up confidently repeating a fact that was
    never active.
    */
    return {
      result: {
        saved: !stored.duplicate,
        alreadyKnown: stored.duplicate,
        status: stored.memory.status,
        ...(stored.superseded ? { replaced: stored.superseded.content } : {}),
      },
    };
  }
  if (name === 'create_reminder') {
    const a = (args && typeof args === 'object' ? args : {}) as {
      message?: unknown;
      whenISO?: unknown;
    };
    if (typeof a.message !== 'string' || !a.message.trim()) {
      return { error: 'Missing required "message" argument' };
    }
    if (typeof a.whenISO !== 'string' || !a.whenISO.trim()) {
      return { error: 'Missing required "whenISO" argument' };
    }
    const when = new Date(a.whenISO);
    if (Number.isNaN(when.getTime())) {
      return { error: 'Invalid "whenISO" — must be a valid ISO 8601 datetime' };
    }
    if (when.getTime() <= Date.now()) {
      return { error: '"whenISO" must be in the future' };
    }
    const message = a.message.trim();
    // timeOfDay/daysOfWeek are unused for a one-off reminder (recurring:
    // false) — nextRunAt is the exact target moment instead. See
    // ScheduledTaskRow's doc comment in db.ts and the tick()/
    // runScheduledTask() handling in scheduler.ts.
    createScheduledTask({
      name: deriveSessionTitle(message),
      prompt: message,
      model,
      timeOfDay: '00:00',
      daysOfWeek: [],
      recurring: false,
      toolsEnabled: true,
      memoryEnabled: true,
      nextRunAt: when.getTime(),
    });
    // The weekday travels with every date a tool hands back: a model asked to
    // repeat one will otherwise derive it, and derive it wrong (see
    // weekdayOf). For a reminder that is worse than a wrong forecast — it is
    // wrong information about the user's own calendar.
    return {
      result: { scheduled: true, when: when.toISOString(), weekday: weekdayOf(when) },
    };
  }
  if (name === 'create_recurring_task') {
    const a = (args && typeof args === 'object' ? args : {}) as {
      name?: unknown;
      prompt?: unknown;
      timeOfDay?: unknown;
      daysOfWeek?: unknown;
    };
    if (typeof a.name !== 'string' || !a.name.trim()) {
      return { error: 'Missing required "name" argument' };
    }
    if (typeof a.prompt !== 'string' || !a.prompt.trim()) {
      return { error: 'Missing required "prompt" argument' };
    }
    // Same "HH:MM" constraint POST /api/scheduled-tasks enforces.
    if (typeof a.timeOfDay !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(a.timeOfDay)) {
      return { error: 'Invalid "timeOfDay" — must be 24h "HH:MM" format, e.g. "08:00"' };
    }
    const daysOfWeek = Array.isArray(a.daysOfWeek)
      ? a.daysOfWeek.filter(
          (d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6,
        )
      : [];
    if (daysOfWeek.length === 0) {
      return {
        error:
          'Missing/invalid "daysOfWeek" — must be a non-empty array of integers 0 (Sunday) to 6 (Saturday)',
      };
    }
    const taskName = a.name.trim().slice(0, 200);
    const prompt = a.prompt.trim().slice(0, 4000);
    const nextRunAt = computeNextRunAt(a.timeOfDay, daysOfWeek, new Date());
    createScheduledTask({
      name: taskName,
      prompt,
      model,
      timeOfDay: a.timeOfDay,
      daysOfWeek,
      recurring: true,
      toolsEnabled: true,
      memoryEnabled: true,
      nextRunAt,
    });
    return {
      result: {
        scheduled: true,
        name: taskName,
        nextRunAt: new Date(nextRunAt).toISOString(),
        nextRunWeekday: weekdayOf(nextRunAt),
      },
    };
  }
  if (name === 'list_scheduled_tasks') {
    const tasks = listScheduledTasks().map((t) => ({
      id: t.id,
      name: t.name,
      recurring: t.recurring,
      ...(t.recurring
        ? { timeOfDay: t.timeOfDay, daysOfWeek: t.daysOfWeek }
        : {
            whenISO: t.nextRunAt ? new Date(t.nextRunAt).toISOString() : null,
            whenWeekday: t.nextRunAt ? weekdayOf(t.nextRunAt) : null,
          }),
    }));
    return { result: { tasks } };
  }
  if (name === 'cancel_scheduled_task') {
    const a = (args && typeof args === 'object' ? args : {}) as {
      id?: unknown;
      name?: unknown;
    };
    const tasks = listScheduledTasks();
    let match: (typeof tasks)[number] | undefined;
    if (typeof a.id === 'string' && a.id.trim()) {
      match = tasks.find((t) => t.id === (a.id as string).trim());
      if (!match) return { error: `No scheduled task found with id "${a.id}"` };
    } else if (typeof a.name === 'string' && a.name.trim()) {
      const needle = a.name.trim().toLowerCase();
      const matches = tasks.filter((t) => t.name.toLowerCase().includes(needle));
      if (matches.length === 0) {
        return { error: `No scheduled task found matching "${a.name}"` };
      }
      if (matches.length > 1) {
        return {
          error: `Multiple tasks match "${a.name}" — call list_scheduled_tasks and use the exact id instead: ${matches.map((m) => `"${m.name}" (${m.id})`).join(', ')}`,
        };
      }
      match = matches[0];
    } else {
      return { error: 'Provide either "id" or "name" to identify which task to cancel' };
    }
    deleteScheduledTask(match.id);
    return { result: { cancelled: true, id: match.id, name: match.name } };
  }
  if (name === 'get_weather') {
    const a = (args && typeof args === 'object' ? args : {}) as {
      location?: unknown;
      days?: unknown;
    };
    if (typeof a.location !== 'string' || !a.location.trim()) {
      return { error: 'Missing required "location" argument' };
    }
    // Models frequently send integer-typed args as strings (observed live
    // with llama3.1:8b sending {"days":"3"} despite the schema saying
    // integer) — coerce rather than silently falling back to the default.
    const daysRaw = typeof a.days === 'string' ? Number(a.days) : a.days;
    const days = Math.min(
      Math.max(
        typeof daysRaw === 'number' && Number.isFinite(daysRaw) ? Math.round(daysRaw) : 3,
        1,
      ),
      7,
    );
    try {
      const result = await getWeather(a.location.trim(), days);
      return { result };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : 'get_weather failed' };
    }
  }
  if (name === 'calculator') {
    const a = (args && typeof args === 'object' ? args : {}) as { expression?: unknown };
    if (typeof a.expression !== 'string' || !a.expression.trim()) {
      return { error: 'Missing required "expression" argument' };
    }
    try {
      return { result: { expression: a.expression, value: evaluateExpression(a.expression) } };
    } catch (e: unknown) {
      return { error: e instanceof Error ? e.message : 'calculator failed' };
    }
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

export interface GenerationParams {
  base: string;
  model: string;
  messages: ChatMessageIn[];
  think: boolean;
  options: unknown;
  toolsEnabled: boolean;
  memoryEnabled: boolean;
  searxngTemplate: string | null;
  // Tool names to hide from the model for this run — see buildTools' doc
  // comment. Optional; empty/absent means the normal full set.
  excludeTools?: string[];
  // Called once, right before a successful ('done') completion is persisted
  // and published — may return a replacement content string (e.g. to append
  // a warning), or nothing to leave the generated content as-is. Lets a
  // caller layer a domain-specific post-check (e.g. "did this actually
  // schedule the reminder it claims to have set?" — see
  // src/lib/schedule-verify.ts) without this generic engine needing to know
  // what a reminder is. Never runs for 'aborted'; a thrown/rejected
  // postProcess is caught and ignored (the original content survives)
  // rather than breaking an otherwise-successful turn over a broken hook.
  postProcess?: (final: {
    content: string;
    trace: TraceEvent[];
  }) => string | void | Promise<string | void>;
}

/*
Caps how much of a replayed tool result is re-sent. A single stored
web_search result set is several KB and a long chat holds many of them;
what the model needs from its own history is that the call happened and
roughly what came back, not the full payload a second time.
*/
const REPLAYED_TOOL_RESULT_LIMIT = 600;

/*
Rebuilds the tool calls a stored assistant reply actually made.

Only the final answer text is persisted as a message; the calls themselves
live in that message's `trace` (TraceEvent in store/chat.ts), and used to be
dropped entirely when the history went back upstream. The model was
therefore shown a conversation in which it had apparently answered every
"look this up" without ever touching a tool — precedent that pushes it to
skip the tool next time and answer from memory instead. Models with a weak
tool-calling prior follow that precedent readily.

Emitted in the shape Ollama expects: one assistant message carrying
`tool_calls`, then one `tool` message per result.
*/
export function replayToolTrace(trace: TraceEvent[] | undefined): ChatMessageIn[] {
  const toolEvents = (trace ?? []).filter((t): t is Extract<TraceEvent, { type: 'tool' }> => {
    return t.type === 'tool';
  });
  if (toolEvents.length === 0) return [];
  const truncate = (s: string) =>
    s.length > REPLAYED_TOOL_RESULT_LIMIT
      ? s.slice(0, REPLAYED_TOOL_RESULT_LIMIT) + '… [truncated]'
      : s;
  return [
    {
      role: 'assistant' as const,
      content: '',
      tool_calls: toolEvents.map((t) => ({
        function: { name: t.name, arguments: t.arguments },
      })),
    },
    ...toolEvents.map((t) => ({
      role: 'tool' as const,
      content: truncate(JSON.stringify(t.error ? { error: t.error } : (t.result ?? null))),
      name: t.name,
    })),
  ];
}

// Runs the actual Ollama tool-calling loop independently of any HTTP
// response — this is what lets generation survive the browser tab closing
// (and, for a scheduled task, run without any tab ever having existed at
// all). Progress is published to the job's subscribers (an open tab tails it
// live), and the final result is persisted to the DB directly, regardless of
// whether anyone is still listening. Never throws past its own catch-alls;
// every exit path settles the job and persists something.
export async function runGeneration(job: Job, params: GenerationParams): Promise<void> {
  const { base, model, think, options, toolsEnabled, memoryEnabled, searxngTemplate } = params;
  const excludeTools = params.excludeTools ?? [];
  const messages: ChatMessageIn[] = params.messages.flatMap((m) => {
    // Ollama wants the image bytes inline as base64. They are stored as
    // attachment ids (see src/lib/db.ts), so they are read back here, at
    // the one moment they're actually needed, rather than being carried
    // through the app as multi-megabyte strings.
    const images = m.images?.length ? m.images : attachmentsAsBase64(m.attachments);
    return [
      // The tool calls this reply made come first, in the order they
      // originally happened: they led to the answer text below them.
      ...replayToolTrace(m.trace),
      {
        role: m.role,
        content: m.content,
        ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
        ...(m.name ? { name: m.name } : {}),
        ...(images.length ? { images } : {}),
      },
    ];
  });

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
    let finalContent = contentAggregated;
    if (status === 'done' && params.postProcess) {
      try {
        const replacement = await params.postProcess({ content: contentAggregated, trace });
        if (typeof replacement === 'string') finalContent = replacement;
      } catch (e) {
        console.error('runGeneration postProcess hook failed, keeping original content:', e);
      }
    }
    publish(job.id, {
      done: true,
      model,
      content: finalContent,
      thinking: thinkingAggregated || undefined,
      stats,
    });
    if (!finalContent && !thinkingAggregated && status === 'done') {
      publish(job.id, { info: 'empty response', model });
    }
    // Passive benchmark logging — every real completion becomes a data point
    // for the /benchmarks history, no extra requests needed. Only real,
    // non-empty generations count (aborted/empty ones have no meaningful
    // speed to record).
    if (status === 'done' && stats.completionTokens && stats.tokensPerSecond) {
      recordBenchmarkRun({
        model,
        source: 'chat',
        promptTokens: stats.promptTokens,
        completionTokens: stats.completionTokens,
        tokensPerSecond: stats.tokensPerSecond,
      });
    }
    settleJob(job.id, status);
    persistFinalAssistantMessage(job.sessionId, job.id, {
      content: finalContent,
      trace,
      stats,
    });
    // Always last: tells an attached response stream it's safe to close now
    // (see the POST handler's subscriber).
    publish(job.id, { streamEnd: true });

    /*
    Second look at what the user just said, once they already have their
    answer — see src/lib/memory-extract.ts for why this exists: during a
    reply the model is answering *and* watching for facts, and the answering
    wins. Measured on a local 35B model, a plainly durable statement was saved
    in 3 of 5 runs even after the tool description was rewritten for it.

    Deliberately fire-and-forget after streamEnd: the reply is already on
    screen, so this costs the user nothing but a little GPU time on a model
    that is still loaded anyway. Skipped entirely when the model did save
    something during the reply, and everything it finds lands as a draft for
    review rather than in the next prompt.
    */
    if (status === 'done' && memoryEnabled && !alreadySavedDuringReply(trace)) {
      const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
      if (text) {
        void extractDurableFacts({
          base,
          model,
          userText: text,
          sessionId: job.sessionId,
        }).catch(() => {
          /* a failed second look must never surface as a failed reply */
        });
      }
    }
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
          ...((toolsEnabled || memoryEnabled) && !isLastIteration
            ? { tools: await buildTools(toolsEnabled, memoryEnabled, excludeTools) }
            : {}),
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
    const turnToolCalls: OllamaToolCall[] = [];
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
          // Append, don't replace: Ollama is free to split a turn's tool
          // calls across chunks (and does, for some model/template
          // combinations), in which case assigning here would keep only
          // whichever batch arrived last and silently drop the rest.
          turnToolCalls.push(...parsed.message.tool_calls);
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
    if (validToolCalls.length && (toolsEnabled || memoryEnabled) && !isLastIteration) {
      messages.push({ role: 'assistant', content: turnContent, tool_calls: validToolCalls });
      openThinkingId = null;
      for (const call of validToolCalls) {
        const name = call.function!.name!;
        const args = call.function!.arguments;
        const id = safeUuid();
        trace.push({ type: 'tool', id, name, arguments: args });
        publish(job.id, { toolCall: { id, name, arguments: args } });
        syncSnapshot();
        const { result, error } = await executeTool(
          name,
          args,
          searxngTemplate,
          job.sessionId,
          model,
        );
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

// Recall doesn't depend on the model choosing to call a tool (unreliable
// across models) — stored facts are injected as context automatically
// whenever memory is effectively on for this session. Capped at the 50 most
// recent facts (listMemories() already orders newest-first) to bound token
// cost regardless of how many accumulate; the user prunes the full list from
// Settings. Merges into an existing system message (persona prompt) rather
// than adding a second one, for template compatibility across models.
/**
 * Picks the memories this particular conversation should carry and puts them
 * in the system prompt.
 *
 * This used to take the newest 50 facts and inject all of them, every time.
 * Two things were wrong with that at once: the newest-50 window drops the
 * oldest fact as soon as the 51st arrives — and the oldest is usually the
 * most fundamental one — while injecting all of them spends context and
 * attention on facts about Docker during a conversation about dinner. Small
 * local models, which is what this app runs, degrade measurably when carrying
 * irrelevant context.
 *
 * So: identity and pinned facts unconditionally, the rest ranked against the
 * conversation itself and capped by a token budget (see recallMemories).
 * Retrieved facts are marked as used, which is what later tells apart the
 * memories that earn their place from the ones that should decay.
 *
 * Only the last few messages form the query — the recent turns are what the
 * reply is actually about, and a long conversation's early history would
 * otherwise dominate the ranking forever.
 */
const RECALL_QUERY_MESSAGES = 4;

export function injectMemories(messages: ChatMessageIn[]): ChatMessageIn[] {
  const query = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-RECALL_QUERY_MESSAGES)
    .map((m) => (typeof m.content === 'string' ? m.content : ''))
    .join(' ')
    .slice(0, 4000);
  const facts = recallMemories({ query });
  if (facts.length === 0) return messages;
  markMemoriesUsed(facts.map((f) => f.id));
  const block = buildMemoryBlock(facts);
  if (!block) return messages;
  if (messages[0]?.role === 'system') {
    return [
      { ...messages[0], content: `${block}\n\n${messages[0].content}` },
      ...messages.slice(1),
    ];
  }
  return [{ role: 'system', content: block }, ...messages];
}
