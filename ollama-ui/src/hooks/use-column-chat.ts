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

async function generateTitle(
  sessionId: string,
  model: string,
  firstUserMessage: string,
  firstAssistantMessage: string,
) {
  try {
    const res = await fetch('/api/sessions/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, firstUserMessage, firstAssistantMessage }),
    });
    if (res.ok) {
      const data = await res.json();
      if (typeof data.title === 'string' && data.title.trim()) {
        useSessionsStore.getState().rename(sessionId, data.title.trim());
        return;
      }
    }
  } catch {
    /* fall through to fallback title */
  }
  const fallback = firstUserMessage.trim().slice(0, 40) || 'New chat';
  useSessionsStore.getState().rename(sessionId, fallback);
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
  }, []);

  const send = useCallback(
    async (text: string, opts: SendOptions) => {
      if (!text.trim() || !model || !sessionId) return;
      const columnTag = column === 'A' ? undefined : column;
      append({
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
      persistSessionMessages(
        sessionId,
        useChatStore.getState().messages.filter((m) => m.sessionId === sessionId),
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

        let responseRaw = '';
        const trace: TraceEvent[] = [];
        let openThinkingId: string | null = null;

        await consumeChatStream(
          res.body,
          {
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
          },
          abortController.signal,
        );
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          // user-initiated stop: keep whatever content already streamed
        } else {
          update(assistantId, { content: '[Chat error]' });
        }
      } finally {
        setLoading(false);
        setColdStart(false);
        setStreamingId(null);
        abortControllerRef.current = null;

        const sessionMessages = useChatStore
          .getState()
          .messages.filter((m) => m.sessionId === sessionId);
        persistSessionMessages(sessionId, sessionMessages);

        if (column === 'A') {
          const session = useSessionsStore.getState().sessions.find((s) => s.id === sessionId);
          const columnAMessages = sessionMessages.filter((m) => (m.column ?? 'A') === 'A');
          if (session && session.titleStatus === 'pending' && columnAMessages.length === 2) {
            const firstUser = columnAMessages.find((m) => m.role === 'user');
            const firstAssistant = columnAMessages.find((m) => m.role === 'assistant');
            if (firstUser?.content && firstAssistant?.content) {
              void generateTitle(sessionId, model, firstUser.content, firstAssistant.content);
            }
          }
        }
      }
    },
    [model, column, sessionId, append, update],
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
