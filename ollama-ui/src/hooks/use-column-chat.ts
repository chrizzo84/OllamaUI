'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChatStore, ChatMessage, TraceEvent } from '@/store/chat';
import { useSessionsStore } from '@/store/sessions';
import { consumeChatStream, readErrorMessage } from '@/lib/chat-stream';
import { deriveSessionTitle, isThinkingModel, safeUuid } from '@/lib/utils';
import { useGenerationStore, getGenerationEntry, generationKey } from '@/store/generation';

export interface SendOptions {
  systemPrompt?: string;
  toolsEnabled: boolean;
  // Whether this model should think/reason. Pass the real value from the
  // model's reported capabilities when known; falls back to a name-based
  // guess (isThinkingModel) only when capabilities weren't available.
  think?: boolean;
  // Context window override (num_ctx) for this model; undefined = server default.
  numCtx?: number;
  /*
  Branch targets, passed straight through to /api/chat. Absent for an
  ordinary send.

  reuseUserMessageId — regenerate: answer the question that is already
                       stored instead of asking it again, so the previous
                       reply stays alongside the new one as an alternative.
  siblingOfMessageId — edit: the rewritten question becomes an alternative
                       to the original rather than deleting it.
  */
  reuseUserMessageId?: string;
  siblingOfMessageId?: string;
}

export interface ColumnChat {
  model: string;
  setModel: (m: string) => void;
  messages: ChatMessage[];
  loading: boolean;
  streamingId: string | null;
  coldStart: boolean;
  coldElapsed: number;
  queuedAhead: number | null;
  lastPayload: unknown;
  // `images`: raw base64 (no data: prefix) attached to this turn's user
  // message — see ChatMessage.images in src/store/chat.ts.
  send: (text: string, opts: SendOptions, images?: string[]) => Promise<void>;
  stop: () => void;
}

async function isModelLoaded(target: string): Promise<boolean> {
  try {
    const r = await fetch('/api/ps', { cache: 'no-store' });
    if (!r.ok) return false;
    const j = (await r.json()) as { models?: Array<{ name?: string; model?: string }> };
    if (!j.models) return false;
    return j.models.some((m) => m.name === target || m.model === target.split(':')[0]);
  } catch {
    return false;
  }
}

// Single/Compare share this hook: column 'A' messages are untagged (so a
// conversation started in single mode carries straight into Compare's left
// column), column 'B' messages are tagged explicitly. Only column 'A' drives
// session title generation.
export function useColumnChat(column: 'A' | 'B', sessionId: string | null): ColumnChat {
  const [model, setModel] = useState('');
  const [coldElapsed, setColdElapsed] = useState(0);
  const [lastPayload, setLastPayload] = useState<unknown>(null);
  // Message ids this hook has already dealt with — either send() is actively
  // streaming it itself, or a reconnect attempt already happened for it
  // (successful or not). Prevents the reconnect effect below from racing
  // send()'s own placeholder (there's a real gap between appending it and
  // the entry actually being marked loading, since isModelLoaded is awaited
  // first) and from retrying a 404 on every unrelated store update. Keyed by
  // message id (globally unique), so it doesn't need to be session-scoped.
  const handledIdsRef = useRef<Set<string>>(new Set());

  const allMessages = useChatStore((s) => s.messages);
  const append = useChatStore((s) => s.append);
  const update = useChatStore((s) => s.update);

  const messages = useMemo(
    () => allMessages.filter((m) => m.sessionId === sessionId && (m.column ?? 'A') === column),
    [allMessages, sessionId, column],
  );

  // In-flight generation state lives in a store keyed by session+column
  // (see src/store/generation.ts), NOT in local component state — this hook
  // instance is shared across every session the user visits (ChatPanel never
  // unmounts it), so local state would leak between sessions: switching away
  // from a session mid-generation and sending a message in a different one
  // would otherwise show the wrong loading indicator and let Stop abort the
  // wrong job. Keying by session+column lets unrelated sessions (and, within
  // one session, columns A/B) generate fully in parallel.
  const key = sessionId ? generationKey(sessionId, column) : null;
  const genEntry = useGenerationStore((s) => (key ? (s.entries[key] ?? null) : null));
  const loading = genEntry?.loading ?? false;
  const streamingId = genEntry?.streamingId ?? null;
  const coldStart = genEntry?.coldStart ?? false;
  const coldStartSince = genEntry?.coldStartSince ?? null;
  const queuedAhead = genEntry?.queuedAhead ?? null;
  const patchEntry = useGenerationStore((s) => s.patch);

  useEffect(() => {
    if (!coldStart || !coldStartSince) return;
    const id = setInterval(() => {
      setColdElapsed(Math.floor((Date.now() - coldStartSince) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [coldStart, coldStartSince]);

  // "Loading model…" is only accurate for as long as the model actually
  // isn't loaded yet. If two parallel chats hit the same model, the second
  // one's own weights may finish loading (or were already loaded all along
  // — Ollama loading is shared, not per-request) while it's still sitting
  // with zero output because Ollama is serializing generation for that model
  // behind the first request. Re-checking periodically clears the stale
  // "loading" label once that's confirmed, so it falls back to the generic
  // "waiting" indicator instead of claiming the model is still loading.
  useEffect(() => {
    if (!coldStart || !key) return;
    let cancelled = false;
    const id = setInterval(async () => {
      const stillLoading = getGenerationEntry(key).coldStart;
      if (cancelled || !stillLoading) return;
      const loaded = await isModelLoaded(model);
      if (!cancelled && loaded) patchEntry(key, { coldStart: false });
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [coldStart, key, model, patchEntry]);

  const stop = useCallback(() => {
    if (!key) return;
    const current = getGenerationEntry(key);
    current.abortController?.abort();
    const jobId = current.jobId;
    if (jobId) {
      fetch(`/api/chat/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {
        /* best-effort — the job will also just finish and persist normally */
      });
    }
  }, [key]);

  // Wires a job's NDJSON body (from either the initial POST /api/chat or a
  // GET /api/chat/jobs/[id] reconnect — same wire format, see chat-stream.ts)
  // to the given message's live state. Shared so send() and the reconnect
  // effect below don't duplicate this handler wiring.
  const attachToJobStream = useCallback(
    async (
      genKey: string,
      assistantId: string,
      body: ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ) => {
      let responseRaw = '';
      const trace: TraceEvent[] = [];
      let openThinkingId: string | null = null;
      // Any real output means this job is no longer just "loading" or
      // "queued behind another one" — it's actively producing.
      const clearWaitIndicators = () => patchEntry(genKey, { coldStart: false, queuedAhead: null });

      await consumeChatStream(
        body,
        {
          // Reconnect catch-up only — never fires for a freshly created job,
          // since it has nothing accumulated yet at that point.
          onSnapshot: (snap) => {
            responseRaw = snap.content ?? '';
            if (Array.isArray(snap.trace)) {
              trace.splice(0, trace.length, ...(snap.trace as TraceEvent[]));
            }
            // Resume coalescing into whatever thinking burst was still open
            // when this job's snapshot was taken, so the next onThinking
            // delta appends instead of starting a spurious new burst.
            const last = trace[trace.length - 1];
            openThinkingId = last && last.type === 'thinking' ? last.id : null;
            update(assistantId, { content: responseRaw, trace: [...trace] });
          },
          onQueued: ({ aheadCount }) => {
            patchEntry(genKey, { queuedAhead: aheadCount });
          },
          onThinking: (delta) => {
            clearWaitIndicators();
            if (openThinkingId) {
              const entry = trace.find((t) => t.id === openThinkingId);
              if (entry && entry.type === 'thinking') entry.text += delta;
            } else {
              const id = safeUuid();
              openThinkingId = id;
              trace.push({ type: 'thinking', id, text: delta });
            }
            update(assistantId, { trace: [...trace] });
          },
          onToken: (delta) => {
            clearWaitIndicators();
            responseRaw += delta;
            update(assistantId, { content: responseRaw });
          },
          onToolCall: (call) => {
            clearWaitIndicators();
            openThinkingId = null;
            trace.push({
              type: 'tool',
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            });
            update(assistantId, { trace: [...trace] });
          },
          onToolResult: (r) => {
            const idx = trace.findIndex((t) => t.id === r.id);
            if (idx !== -1) {
              const existing = trace[idx];
              if (existing.type === 'tool') {
                trace[idx] = { ...existing, result: r.result, error: r.error };
              }
            }
            update(assistantId, { trace: [...trace] });
          },
          // The assistant's answer is fully done here — clear the
          // "responding" UI state immediately rather than waiting for the
          // stream to physically close. The server keeps that connection
          // open a bit longer in the background to attempt title generation
          // (see finishDone in route.ts), which runs against the same model
          // and can itself take a while if another parallel chat is still
          // using it; none of that should make the chat look like it's still
          // generating once the actual answer is already in.
          onDone: (final) => {
            responseRaw = final.content;
            update(assistantId, { content: responseRaw, stats: final.stats });
            patchEntry(genKey, {
              loading: false,
              coldStart: false,
              streamingId: null,
              queuedAhead: null,
            });
          },
          onError: (message) => {
            update(assistantId, { content: '[Error] ' + message });
            patchEntry(genKey, {
              loading: false,
              coldStart: false,
              streamingId: null,
              queuedAhead: null,
            });
          },
        },
        signal,
      );
    },
    [update, patchEntry],
  );

  // Reconnect: if the last message in this column is an empty assistant
  // placeholder, a job may still be running for it server-side (this tab
  // reloaded, or a different tab/device started it) — attach to its live
  // stream instead of leaving it looking stuck. No-ops (via a 404) if
  // there's genuinely nothing left to reconnect to.
  useEffect(() => {
    if (!sessionId || !key) return;
    const genKey = key;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant' || last.content) return;
    if (handledIdsRef.current.has(last.id)) return;
    handledIdsRef.current.add(last.id);

    let cancelled = false;
    const abortController = new AbortController();

    (async () => {
      let res: Response;
      try {
        res = await fetch(`/api/chat/jobs/${last.id}`, { signal: abortController.signal });
      } catch {
        return; // network error — leave the message as-is
      }
      if (cancelled || !res.ok || !res.body) return; // 404 = nothing running, DB content stands
      patchEntry(genKey, {
        jobId: last.id,
        abortController,
        streamingId: last.id,
        loading: true,
      });
      try {
        await attachToJobStream(genKey, last.id, res.body, abortController.signal);
      } catch (e) {
        if (!(e instanceof Error && e.name === 'AbortError')) {
          console.error('Reconnect stream failed', e);
        }
      } finally {
        if (!cancelled) {
          patchEntry(genKey, {
            loading: false,
            coldStart: false,
            streamingId: null,
            abortController: null,
            jobId: null,
            queuedAhead: null,
          });
          /*
          No client-side write here: /api/chat persists the user message and
          the assistant placeholder before it contacts Ollama, and the
          generation job writes the final content itself when it finishes —
          that is what lets a reply survive a closed tab. Sending the whole
          history back from the browser would also destroy branches, since
          a full-history write is "this is the conversation now" and the tab
          only holds the currently-visible path.
          */
        }
      }
    })();

    return () => {
      cancelled = true;
      // Detaches this tab only (see attachToJobStream/cancel semantics in
      // the job registry) — never aborts the job itself just because this
      // component re-ran the effect or unmounted.
      abortController.abort();
    };
    // messages.length (not `messages` itself) is deliberate: `messages` gets
    // a new array reference on every token while attachToJobStream is
    // running (it calls update() constantly), which would otherwise re-run
    // this effect — and its cleanup would abort the very reconnect stream
    // it just started, over and over. .length only changes when a message
    // is actually added (session switch finished loading, a new send()),
    // which is exactly when re-checking is warranted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, key, column, messages.length, attachToJobStream, patchEntry]);

  const send = useCallback(
    async (text: string, opts: SendOptions, images?: string[]) => {
      if (!text.trim() || !model || !sessionId) return;
      const genKey = generationKey(sessionId, column);
      // Guards against this exact session+column already generating (the
      // composer's Send button already prevents this for the session the
      // user is currently looking at — this is a second line of defense for
      // any other caller, e.g. regenerate). Does NOT block other
      // sessions/columns, which is the whole point: those run independently.
      if (getGenerationEntry(genKey).loading) return;
      const columnTag = column === 'A' ? undefined : column;
      /*
      Regenerating reuses the question that is already on screen and in the
      database rather than appending a second copy of it — the user asked
      once. Only the reply is new, and it hangs off that same question,
      which is what makes the previous reply its sibling.
      */
      const userId =
        opts.reuseUserMessageId ??
        append({
          role: 'user',
          content: text.trim(),
          model,
          sessionId,
          column: columnTag,
          ...(images?.length ? { images } : {}),
        });
      const assistantId = append({
        role: 'assistant',
        content: '',
        model,
        sessionId,
        column: columnTag,
      });
      // Title derivation only needs the user's own message, not the
      // assistant's reply — so it happens immediately, right here, instead
      // of waiting on (and depending on the success of) generation. Gated on
      // titleStatus still being 'pending', which is only ever true before a
      // session's first message — see deriveSessionTitle's doc comment for
      // why this replaced an actual model call.
      if (column === 'A') {
        const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
        if (session?.titleStatus === 'pending') {
          useSessionsStore.getState().rename(sessionId, deriveSessionTitle(text));
        }
      }
      patchEntry(genKey, { jobId: assistantId });
      // Mark it handled synchronously, before any await below — otherwise
      // there's a real gap (isModelLoaded is awaited next) where the
      // reconnect effect could see this exact placeholder and race it with
      // its own GET reconnect attempt.
      handledIdsRef.current.add(assistantId);
      // Read the exact stored objects back (rather than reconstructing them)
      // so the server persists byte-identical createdAt/model/column to what
      // the client store already holds. They travel in the /api/chat body,
      // which is what writes them — see the note above about why the
      // browser no longer PATCHes the whole history alongside it.
      const storeMessages = useChatStore.getState().messages;
      const userMessage = storeMessages.find((m) => m.id === userId);
      const assistantMessage = storeMessages.find((m) => m.id === assistantId);

      const loaded = await isModelLoaded(model);
      if (!loaded) {
        patchEntry(genKey, { coldStart: true, coldStartSince: Date.now() });
        setColdElapsed(0);
      }
      const abortController = new AbortController();
      patchEntry(genKey, { streamingId: assistantId, loading: true, abortController });

      try {
        const current = useChatStore
          .getState()
          .messages.filter((m) => m.sessionId === sessionId && (m.column ?? 'A') === column);
        const upstreamMessages = [
          ...(opts.systemPrompt?.trim()
            ? [{ role: 'system' as const, content: opts.systemPrompt.trim() }]
            : []),
          ...current
            .filter((m) => m.role !== 'assistant' || m.content)
            .map((m) => {
              // Only the tool entries of the trace go back to the server —
              // it replays them so the model can see the calls its earlier
              // replies actually made (replayToolTrace in
              // generation-runner.ts). Thinking entries are deliberately
              // left out: they're the largest part of a trace and are not
              // part of the tool-use precedent this is here to preserve.
              const toolTrace = m.trace?.filter((t) => t.type === 'tool');
              return {
                role: m.role as 'user' | 'assistant' | 'system',
                content: m.content,
                ...(m.images?.length ? { images: m.images } : {}),
                ...(toolTrace?.length ? { trace: toolTrace } : {}),
              };
            }),
        ];
        const payload = {
          model,
          messages: upstreamMessages,
          think: opts.think ?? isThinkingModel(model),
          toolsEnabled: opts.toolsEnabled,
          ...(opts.numCtx ? { options: { num_ctx: opts.numCtx } } : {}),
          sessionId,
          column,
          // Omitted when regenerating: the question is already stored, and
          // resending it would just rewrite the row it is already in.
          ...(opts.reuseUserMessageId ? {} : { userMessage }),
          assistantMessage,
          // Where the new reply attaches. Regenerating names the question
          // it answers; editing names the message it is an alternative to.
          ...(opts.reuseUserMessageId ? { parentMessageId: opts.reuseUserMessageId } : {}),
          ...(opts.siblingOfMessageId ? { siblingOfMessageId: opts.siblingOfMessageId } : {}),
        };
        setLastPayload(payload);
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: abortController.signal,
        });
        if (!res.ok) {
          update(assistantId, { content: '[Error] ' + (await readErrorMessage(res)) });
          return;
        }
        if (!res.body) throw new Error('No body');

        await attachToJobStream(genKey, assistantId, res.body, abortController.signal);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          // user-initiated stop: keep whatever content already streamed
        } else {
          console.error('Chat stream failed', e);
          const detail = e instanceof Error ? e.message : String(e);
          update(assistantId, { content: `[Chat error] ${detail}` });
        }
      } finally {
        patchEntry(genKey, {
          loading: false,
          coldStart: false,
          streamingId: null,
          abortController: null,
          jobId: null,
          queuedAhead: null,
        });
      }
    },
    [model, column, sessionId, append, update, attachToJobStream, patchEntry],
  );

  return {
    model,
    setModel,
    messages,
    loading,
    streamingId,
    coldStart,
    coldElapsed,
    queuedAhead,
    lastPayload,
    send,
    stop,
  };
}
