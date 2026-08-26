'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatStore, ChatMessage, TraceEvent } from '@/store/chat';
import { useSessionsStore, persistSessionMessages } from '@/store/sessions';
import { consumeChatStream, readErrorMessage } from '@/lib/chat-stream';
import { isThinkingModel, safeUuid } from '@/lib/utils';

export interface SendOptions {
  systemPrompt?: string;
  toolsEnabled: boolean;
  searxTemplate: string;
  // Whether this model should think/reason. Pass the real value from the
  // model's reported capabilities when known; falls back to a name-based
  // guess (isThinkingModel) only when capabilities weren't available.
  think?: boolean;
  // Context window override (num_ctx) for this model; undefined = server default.
  numCtx?: number;
}

export interface ColumnChat {
  model: string;
  setModel: (m: string) => void;
  messages: ChatMessage[];
  loading: boolean;
  streamingId: string | null;
  coldStart: boolean;
  coldElapsed: number;
  lastPayload: unknown;
  send: (text: string, opts: SendOptions) => Promise<void>;
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
  const [loading, setLoading] = useState(false);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [coldStart, setColdStart] = useState(false);
  const [coldStartSince, setColdStartSince] = useState<number | null>(null);
  const [coldElapsed, setColdElapsed] = useState(0);
  const [lastPayload, setLastPayload] = useState<unknown>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // The current job id (== the streaming assistant message's id), so stop()
  // can tell the server to actually cancel generation — aborting the local
  // fetch alone only detaches this tab's view, the job keeps running
  // server-side otherwise (that's the whole point of the job model).
  const jobIdRef = useRef<string | null>(null);
  // Message ids this hook has already dealt with — either send() is actively
  // streaming it itself, or a reconnect attempt already happened for it
  // (successful or not). Prevents the reconnect effect below from racing
  // send()'s own placeholder (there's a real gap between appending it and
  // setStreamingId actually being set, since isModelLoaded is awaited first)
  // and from retrying a 404 on every unrelated store update.
  const handledIdsRef = useRef<Set<string>>(new Set());

  const allMessages = useChatStore((s) => s.messages);
  const append = useChatStore((s) => s.append);
  const update = useChatStore((s) => s.update);

  const messages = allMessages.filter(
    (m) => m.sessionId === sessionId && (m.column ?? 'A') === column,
  );

  useEffect(() => {
    if (!coldStart || !coldStartSince) return;
    const id = setInterval(() => {
      setColdElapsed(Math.floor((Date.now() - coldStartSince) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [coldStart, coldStartSince]);

  const stop = useCallback(() => {
    abortControllerRef.current?.abort();
    const jobId = jobIdRef.current;
    if (jobId) {
      fetch(`/api/chat/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {
        /* best-effort — the job will also just finish and persist normally */
      });
    }
  }, []);

  // Wires a job's NDJSON body (from either the initial POST /api/chat or a
  // GET /api/chat/jobs/[id] reconnect — same wire format, see chat-stream.ts)
  // to the given message's live state. Shared so send() and the reconnect
  // effect below don't duplicate this handler wiring.
  const attachToJobStream = useCallback(
    async (assistantId: string, body: ReadableStream<Uint8Array>, signal: AbortSignal) => {
      let responseRaw = '';
      const trace: TraceEvent[] = [];
      let openThinkingId: string | null = null;

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
          onThinking: (delta) => {
            setColdStart(false);
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
            setColdStart(false);
            responseRaw += delta;
            update(assistantId, { content: responseRaw });
          },
          onToolCall: (call) => {
            setColdStart(false);
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
          onDone: (final) => {
            responseRaw = final.content;
            update(assistantId, { content: responseRaw, stats: final.stats });
          },
          onError: (message) => {
            update(assistantId, { content: '[Error] ' + message });
          },
          // Title generation runs server-side (src/lib/chat-persistence.ts)
          // once the job finishes, so it survives the tab closing too — this
          // just keeps the sidebar live for a tab that's still open, since
          // the DB is already updated by the time this event arrives.
          onTitleGenerated: ({ sessionId: sid, title }) => {
            useSessionsStore.getState().rename(sid, title);
          },
        },
        signal,
      );
    },
    [update],
  );

  // Reconnect: if the last message in this column is an empty assistant
  // placeholder, a job may still be running for it server-side (this tab
  // reloaded, or a different tab/device started it) — attach to its live
  // stream instead of leaving it looking stuck. No-ops (via a 404) if
  // there's genuinely nothing left to reconnect to.
  useEffect(() => {
    if (!sessionId) return;
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
      jobIdRef.current = last.id;
      abortControllerRef.current = abortController;
      setStreamingId(last.id);
      setLoading(true);
      try {
        await attachToJobStream(last.id, res.body, abortController.signal);
      } catch (e) {
        if (!(e instanceof Error && e.name === 'AbortError')) {
          console.error('Reconnect stream failed', e);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setColdStart(false);
          setStreamingId(null);
          abortControllerRef.current = null;
          jobIdRef.current = null;
          const sessionMessages = useChatStore
            .getState()
            .messages.filter((m) => m.sessionId === sessionId);
          persistSessionMessages(sessionId, sessionMessages);
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
  }, [sessionId, column, messages.length, attachToJobStream]);

  const send = useCallback(
    async (text: string, opts: SendOptions) => {
      if (!text.trim() || !model || !sessionId) return;
      const columnTag = column === 'A' ? undefined : column;
      const userId = append({
        role: 'user',
        content: text.trim(),
        model,
        sessionId,
        column: columnTag,
      });
      const assistantId = append({
        role: 'assistant',
        content: '',
        model,
        sessionId,
        column: columnTag,
      });
      jobIdRef.current = assistantId;
      // Mark it handled synchronously, before any await below — otherwise
      // there's a real gap (isModelLoaded is awaited next) where the
      // reconnect effect could see this exact placeholder and race it with
      // its own GET reconnect attempt.
      handledIdsRef.current.add(assistantId);
      // Read the exact stored objects back (rather than reconstructing them)
      // so the server persists byte-identical createdAt/model/column to what
      // the client store already holds.
      const storeMessages = useChatStore.getState().messages;
      const userMessage = storeMessages.find((m) => m.id === userId);
      const assistantMessage = storeMessages.find((m) => m.id === assistantId);
      persistSessionMessages(
        sessionId,
        storeMessages.filter((m) => m.sessionId === sessionId),
      );

      const loaded = await isModelLoaded(model);
      if (!loaded) {
        setColdStart(true);
        setColdStartSince(Date.now());
        setColdElapsed(0);
      }
      setStreamingId(assistantId);
      setLoading(true);
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

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
            .map((m) => ({ role: m.role as 'user' | 'assistant' | 'system', content: m.content })),
        ];
        const payload = {
          model,
          messages: upstreamMessages,
          think: opts.think ?? isThinkingModel(model),
          toolsEnabled: opts.toolsEnabled,
          ...(opts.numCtx ? { options: { num_ctx: opts.numCtx } } : {}),
          sessionId,
          column,
          userMessage,
          assistantMessage,
        };
        setLastPayload(payload);
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.toolsEnabled && opts.searxTemplate.trim()
              ? { 'x-searxng-endpoint-template': opts.searxTemplate.trim() }
              : {}),
          },
          body: JSON.stringify(payload),
          signal: abortController.signal,
        });
        if (!res.ok) {
          update(assistantId, { content: '[Error] ' + (await readErrorMessage(res)) });
          return;
        }
        if (!res.body) throw new Error('No body');

        await attachToJobStream(assistantId, res.body, abortController.signal);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          // user-initiated stop: keep whatever content already streamed
        } else {
          console.error('Chat stream failed', e);
          const detail = e instanceof Error ? e.message : String(e);
          update(assistantId, { content: `[Chat error] ${detail}` });
        }
      } finally {
        setLoading(false);
        setColdStart(false);
        setStreamingId(null);
        abortControllerRef.current = null;
        jobIdRef.current = null;

        const sessionMessages = useChatStore
          .getState()
          .messages.filter((m) => m.sessionId === sessionId);
        persistSessionMessages(sessionId, sessionMessages);
      }
    },
    [model, column, sessionId, append, update, attachToJobStream],
  );

  return {
    model,
    setModel,
    messages,
    loading,
    streamingId,
    coldStart,
    coldElapsed,
    lastPayload,
    send,
    stop,
  };
}
