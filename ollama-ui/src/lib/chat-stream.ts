// Shared client-side NDJSON stream parser for /api/chat and
// /api/chat/jobs/[id] responses (same wire format for both — the latter is
// just reconnecting to an already-running job instead of starting one).
//
// One JSON object per line:
//   { snapshot: {content?, thinking?, trace?} } -- reconnect catch-up, if any (always first)
//   { thinking: string, model }              -- reasoning delta
//   { token: string, model }                 -- content delta
//   { toolCall: { id, name, arguments } }     -- model requested a tool call
//   { toolResult: { id, name, result? , error? } } -- tool call resolved
//   { done: true, model, content, thinking? } -- final, AUTHORITATIVE full values (not deltas)
//   { titleGenerated: { sessionId, title } }  -- background title generation finished
//   { error: string }                        -- fatal error
//   { streamEnd: true }                      -- control-only: safe to stop reading, no handler needed
//
// IMPORTANT: `done` must be checked before `thinking`/`token`, since the done
// event also carries a `thinking` field holding the FULL aggregated text (not
// a delta). Treating it as a delta would double-append the reasoning text.

export interface ToolCallEvent {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolResultEvent {
  id: string;
  name: string;
  result?: unknown;
  error?: string;
}

export interface ChatStats {
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
}

// Emitted once, first, when reconnecting to a job that's already made
// progress (GET /api/chat/jobs/[id]) — everything accumulated so far. Kept
// loosely typed (not importing TraceEvent from @/store/chat) to avoid a
// circular import; consumers reconstruct their own trace shape from this.
export interface StreamSnapshot {
  content?: string;
  thinking?: string;
  trace?: unknown[];
}

export interface ChatStreamHandlers {
  onThinking?: (delta: string) => void;
  onToken?: (delta: string) => void;
  onToolCall?: (call: ToolCallEvent) => void;
  onToolResult?: (result: ToolResultEvent) => void;
  onDone?: (final: { content: string; thinking?: string; stats?: ChatStats }) => void;
  onError?: (message: string) => void;
  // Published server-side once background title generation finishes (see
  // src/lib/chat-persistence.ts) — the DB is already updated by the time
  // this arrives, this just lets an open tab update its sidebar live.
  onTitleGenerated?: (data: { sessionId: string; title: string }) => void;
  // Reconnect catch-up — see StreamSnapshot above. Only ever the first event
  // on a stream, if present at all.
  onSnapshot?: (snapshot: StreamSnapshot) => void;
}

interface StreamLine {
  thinking?: string;
  token?: string;
  toolCall?: ToolCallEvent;
  toolResult?: ToolResultEvent;
  done?: boolean;
  content?: string;
  stats?: ChatStats;
  error?: string;
  titleGenerated?: { sessionId: string; title: string };
  snapshot?: StreamSnapshot;
  streamEnd?: boolean;
  [key: string]: unknown;
}

export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const onAbort = () => {
    reader.cancel().catch(() => {
      /* ignore */
    });
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (readErr) {
        // reader.cancel() during abort rejects the pending read; treat as a clean stop.
        if (signal?.aborted) return;
        throw readErr;
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        processLine(line, handlers);
      }
    }
    if (buffer.trim()) processLine(buffer.trim(), handlers);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function processLine(line: string, handlers: ChatStreamHandlers) {
  let obj: StreamLine;
  try {
    obj = JSON.parse(line) as StreamLine;
  } catch {
    return;
  }
  if (typeof obj.error === 'string') {
    handlers.onError?.(obj.error);
    return;
  }
  if (obj.snapshot) {
    handlers.onSnapshot?.(obj.snapshot);
    return;
  }
  if (obj.done === true) {
    handlers.onDone?.({
      content: typeof obj.content === 'string' ? obj.content : '',
      thinking: typeof obj.thinking === 'string' ? obj.thinking : undefined,
      stats: obj.stats,
    });
    return;
  }
  if (obj.toolCall) {
    handlers.onToolCall?.(obj.toolCall);
    return;
  }
  if (obj.toolResult) {
    handlers.onToolResult?.(obj.toolResult);
    return;
  }
  if (obj.titleGenerated) {
    handlers.onTitleGenerated?.(obj.titleGenerated);
    return;
  }
  if (typeof obj.thinking === 'string') {
    handlers.onThinking?.(obj.thinking);
    return;
  }
  if (typeof obj.token === 'string') {
    handlers.onToken?.(obj.token);
    return;
  }
}

// Reads an error message from a non-OK fetch Response, trying the {error}
// NDJSON/JSON shape first, then falling back to raw text, then statusText.
export async function readErrorMessage(res: Response): Promise<string> {
  try {
    const clone = res.clone();
    const text = await clone.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        if (typeof parsed.error === 'string' && parsed.error) return parsed.error;
      } catch {
        /* not JSON */
      }
      return text.slice(0, 500);
    }
  } catch {
    /* ignore */
  }
  return res.statusText || `Request failed (${res.status})`;
}
