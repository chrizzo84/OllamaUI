'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useChatStore, type ChatMessage } from '@/store/chat';
import { useToastStore } from '@/store/toast';
import { useSystemPromptStore } from '@/store/system-prompt';
import { useToolsStore } from '@/store/tools';
import { useSessionsStore, loadSessionMessages, persistSessionMessages } from '@/store/sessions';
import { usePrefsStore } from '@/store/prefs';
import { useColumnChat } from '@/hooks/use-column-chat';
import { ChatColumn } from './chat-column';
import { NumCtxControl } from './num-ctx-control';
import { Brain, Wrench, Search, TriangleAlert, Send, Square, FoldVertical } from 'lucide-react';
import { Button } from './ui/button';
import { DEFAULT_MIN_NUM_CTX, hasCapability, safeUuid } from '@/lib/utils';

interface ModelTag {
  name: string;
  details?: { context_length?: number };
}
interface TagsResponse {
  models: ModelTag[];
}
interface ModelShowResponse {
  capabilities?: string[];
}

async function fetchModels(): Promise<TagsResponse> {
  const r = await fetch('/api/models', { cache: 'no-store' });
  if (!r.ok) throw new Error('Model Load failed');
  return r.json();
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 100) / 10}K`;
  return String(n);
}

async function fetchModelShow(model: string): Promise<ModelShowResponse> {
  const r = await fetch('/api/models/show', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model }),
  });
  if (!r.ok) throw new Error('Model info load failed');
  return r.json();
}

function useModelCapabilities(model: string) {
  const { data } = useQuery({
    queryKey: ['ollama-model-show', model],
    queryFn: () => fetchModelShow(model),
    enabled: !!model,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
  return data?.capabilities;
}

interface PsModel {
  name?: string;
  model?: string;
  context_length?: number;
}

/**
 * The context window the model is ACTUALLY running with (num_ctx), as reported
 * by /api/ps for loaded models (Ollama >= 0.6). The context_length in /api/tags
 * is only the model's architectural maximum — Ollama's runtime default (4096,
 * or OLLAMA_CONTEXT_LENGTH) is usually far smaller.
 */
function useEffectiveContext(model: string): number | undefined {
  const { data } = useQuery({
    queryKey: ['ollama-ps-context', model],
    queryFn: async () => {
      const r = await fetch('/api/ps', { cache: 'no-store' });
      if (!r.ok) return null;
      return (await r.json()) as { models?: PsModel[] };
    },
    enabled: !!model,
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: false,
  });
  const entry = data?.models?.find((m) => m.name === model || m.model === model);
  return typeof entry?.context_length === 'number' && entry.context_length > 0
    ? entry.context_length
    : undefined;
}

function CapabilityBadges({ capabilities }: { capabilities: string[] | undefined }) {
  if (!capabilities) return null;
  return (
    <>
      {hasCapability(capabilities, 'thinking') && (
        <span className="cap-pill border-amber-500/30 bg-amber-500/10 text-amber-300/90">
          <Brain className="h-3 w-3" /> thinking
        </span>
      )}
      {hasCapability(capabilities, 'tools') && (
        <span className="cap-pill border-cyan-500/30 bg-cyan-500/10 text-cyan-300/90">
          <Wrench className="h-3 w-3" /> tools
        </span>
      )}
    </>
  );
}

function ContextBadge({
  maxContext,
  effectiveContext,
  usedTokens,
}: {
  maxContext: number | undefined;
  effectiveContext: number | undefined;
  usedTokens: number | undefined;
}) {
  // Prefer the runtime window (/api/ps); the tags value is only the model max.
  const limit = effectiveContext ?? maxContext;
  if (!limit) return null;
  const isRuntime = effectiveContext != null;
  const pct = usedTokens != null ? Math.min(100, Math.round((usedTokens / limit) * 100)) : null;
  const titleParts: string[] = [];
  if (usedTokens != null) titleParts.push(`~${usedTokens} context tokens used (last request)`);
  if (isRuntime) {
    titleParts.push(`Runtime context window (num_ctx): ${effectiveContext} tokens`);
    if (maxContext && maxContext !== effectiveContext)
      titleParts.push(`Model maximum: ${maxContext} tokens`);
  } else {
    titleParts.push(
      `Model maximum: ${maxContext} tokens — the app requests at least ${DEFAULT_MIN_NUM_CTX} tokens by default (see the num_ctx control). Load the model to see the actual runtime value.`,
    );
  }
  return (
    <span
      className={`cap-pill ${
        pct != null && pct >= 80
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300/90'
          : 'border-white/15 bg-white/5 text-white/45'
      }`}
      title={titleParts.join(' · ')}
    >
      {usedTokens != null
        ? `${formatTokenCount(usedTokens)}/${isRuntime ? '' : '≤'}${formatTokenCount(limit)} ctx`
        : `${isRuntime ? '' : '≤'}${formatTokenCount(limit)} ctx`}
    </span>
  );
}

function ModelSelect({
  value,
  onChange,
  models,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  models: ModelTag[] | undefined;
  placeholder: string;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-lg border border-white/10 bg-white/[0.07] px-2.5 py-1.5 text-xs text-white transition-colors hover:border-white/20 focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)] focus:ring-2 focus:ring-[rgb(var(--accent-glow)/0.35)]"
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {models?.map((m) => (
        <option key={m.name} value={m.name} className="bg-neutral-900">
          {m.name}
        </option>
      ))}
    </select>
  );
}

export function ChatPanel() {
  const { data } = useQuery({ queryKey: ['ollama-model-tags'], queryFn: fetchModels });
  const [activeHost, setActiveHost] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [lastSnapshot, setLastSnapshot] = useState<
    ReturnType<typeof useChatStore.getState>['messages'] | null
  >(null);
  const [undoTimeoutId, setUndoTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [input, setInput] = useState('');

  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeId);
  const patchSession = useSessionsStore((s) => s.patch);
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const setSessionMessages = useChatStore((s) => s.setSessionMessages);

  useEffect(() => {
    async function loadHost() {
      try {
        const r = await fetch('/api/hosts');
        if (!r.ok) return;
        const j = await r.json();
        type Host = { url: string; active: boolean };
        const active = Array.isArray(j.hosts) ? (j.hosts as Host[]).find((h) => !!h.active) : null;
        setActiveHost(active?.url || null);
      } catch {
        /* ignore */
      }
    }
    loadHost();
    function onActive() {
      loadHost();
    }
    window.addEventListener('active-host-changed', onActive as EventListener);
    return () => window.removeEventListener('active-host-changed', onActive as EventListener);
  }, []);

  const profiles = useSystemPromptStore((s) => s.profiles);
  const hydrateProfiles = useSystemPromptStore((s) => s.hydrate);
  useEffect(() => {
    hydrateProfiles?.();
  }, [hydrateProfiles]);
  const activeProfile = profiles.find((p) => p.id === activeSession?.profileId);
  const activePrompt = activeProfile?.prompt || '';

  const toolsEnabled = useToolsStore((s) => s.toolsEnabled);
  const searxTemplate = useToolsStore((s) => s.searxngTemplate);
  const hydrateTools = useToolsStore((s) => s.hydrate);
  useEffect(() => {
    hydrateTools();
  }, [hydrateTools]);

  // Always instantiate both columns (rules of hooks) — column B is simply
  // unused/unmounted in single mode.
  const columnA = useColumnChat('A', activeSessionId);
  const columnB = useColumnChat('B', activeSessionId);

  const capsA = useModelCapabilities(columnA.model);
  const capsB = useModelCapabilities(compareMode ? columnB.model : '');
  const supportsToolsA = hasCapability(capsA, 'tools');
  const effectiveCtxA = useEffectiveContext(columnA.model);
  const effectiveCtxB = useEffectiveContext(compareMode ? columnB.model : '');

  const contextLengthA = data?.models.find((m) => m.name === columnA.model)?.details
    ?.context_length;
  const contextLengthB = data?.models.find((m) => m.name === columnB.model)?.details
    ?.context_length;

  const numCtxOverrideA = usePrefsStore((s) =>
    columnA.model ? s.numCtxByModel[columnA.model] : undefined,
  );
  const numCtxOverrideB = usePrefsStore((s) =>
    columnB.model ? s.numCtxByModel[columnB.model] : undefined,
  );
  const numCtxA =
    numCtxOverrideA ??
    (columnA.model
      ? Math.min(DEFAULT_MIN_NUM_CTX, contextLengthA ?? DEFAULT_MIN_NUM_CTX)
      : undefined);
  const numCtxB =
    numCtxOverrideB ??
    (columnB.model
      ? Math.min(DEFAULT_MIN_NUM_CTX, contextLengthB ?? DEFAULT_MIN_NUM_CTX)
      : undefined);
  const lastPromptTokensA = [...columnA.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.stats?.promptTokens != null)?.stats?.promptTokens;
  const lastPromptTokensB = [...columnB.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.stats?.promptTokens != null)?.stats?.promptTokens;

  // On session switch: load its persisted history, restore which models &
  // compare-mode it used. Column A falls back to the last model used on
  // this host if the session doesn't have one yet (brand-new session).
  useEffect(() => {
    if (!activeSessionId) return;
    let cancelled = false;
    (async () => {
      const messages = await loadSessionMessages(activeSessionId);
      if (cancelled) return;
      setSessionMessages(activeSessionId, messages);
      const session = useSessionsStore.getState().sessions.find((s) => s.id === activeSessionId);
      let fallbackModelA = '';
      try {
        if (activeHost) {
          const raw = localStorage.getItem('ollama_ui_selected_models');
          const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
          fallbackModelA = map[activeHost] || '';
        }
      } catch {
        /* ignore */
      }
      columnA.setModel(session?.modelA || fallbackModelA);
      columnB.setModel(session?.modelB || '');
      setCompareMode(!!session?.compareMode);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Deep link from the retired /playground route.
  useEffect(() => {
    if (typeof window === 'undefined' || !activeSessionId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('compare') === '1') {
      setCompareMode(true);
      patchSession(activeSessionId, { compareMode: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  // Persist model/compare-mode choices onto the active session.
  useEffect(() => {
    if (!activeSessionId || !columnA.model) return;
    patchSession(activeSessionId, { modelA: columnA.model });
    try {
      if (activeHost) {
        const raw = localStorage.getItem('ollama_ui_selected_models');
        const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
        map[activeHost] = columnA.model;
        localStorage.setItem('ollama_ui_selected_models', JSON.stringify(map));
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnA.model, activeSessionId, activeHost]);
  useEffect(() => {
    if (!activeSessionId || !columnB.model) return;
    patchSession(activeSessionId, { modelB: columnB.model });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnB.model, activeSessionId]);
  useEffect(() => {
    if (!activeSessionId) return;
    patchSession(activeSessionId, { compareMode });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareMode, activeSessionId]);

  const allMessages = useChatStore((s) => s.messages);
  const clear = useChatStore((s) => s.clear);
  const restore = useChatStore((s) => s.restore);
  const sessionMessages = allMessages.filter((m) => m.sessionId === activeSessionId);

  const containerRef = useRef<HTMLDivElement | null>(null);

  async function handleSend() {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    const opts = {
      systemPrompt: activePrompt || undefined,
      toolsEnabled,
      searxTemplate,
    };
    const jobs = [
      columnA.send(text, { ...opts, think: hasCapability(capsA, 'thinking'), numCtx: numCtxA }),
    ];
    if (compareMode && columnB.model) {
      jobs.push(
        columnB.send(text, { ...opts, think: hasCapability(capsB, 'thinking'), numCtx: numCtxB }),
      );
    }
    await Promise.all(jobs);
  }

  function handleStop() {
    columnA.stop();
    if (compareMode) columnB.stop();
  }

  const pushToast = useToastStore((s) => s.push);

  function regenerateColumn(column: 'A' | 'B') {
    const col = column === 'A' ? columnA : columnB;
    const numCtx = column === 'A' ? numCtxA : numCtxB;
    const caps = column === 'A' ? capsA : capsB;
    if (!activeSessionId || !col.model || col.loading) return;
    const msgs = col.messages;
    const last = msgs[msgs.length - 1];
    const secondLast = msgs[msgs.length - 2];
    if (!last || last.role !== 'assistant' || !secondLast || secondLast.role !== 'user') return;
    const lastUserText = secondLast.content;
    const remaining = sessionMessages.filter((m) => m.id !== last.id && m.id !== secondLast.id);
    setSessionMessages(activeSessionId, remaining);
    persistSessionMessages(activeSessionId, remaining);
    void col.send(lastUserText, {
      systemPrompt: activePrompt || undefined,
      toolsEnabled,
      searxTemplate,
      think: hasCapability(caps, 'thinking'),
      numCtx,
    });
  }

  function deletePair(column: 'A' | 'B', assistantMessageId: string) {
    if (!activeSessionId) return;
    const colMessages = sessionMessages.filter((m) => (m.column ?? 'A') === column);
    const idx = colMessages.findIndex((m) => m.id === assistantMessageId);
    if (idx === -1) return;
    const toRemove = new Set([assistantMessageId]);
    const prev = colMessages[idx - 1];
    if (prev && prev.role === 'user') toRemove.add(prev.id);
    const next = sessionMessages.filter((m) => !toRemove.has(m.id));
    setSessionMessages(activeSessionId, next);
    persistSessionMessages(activeSessionId, next);
    pushToast({ type: 'info', message: 'Message pair deleted' });
  }

  const [compacting, setCompacting] = useState(false);
  // Keep this many recent messages verbatim when compacting.
  const KEEP_RECENT = 4;

  async function compactColumn(
    column: 'A' | 'B',
    model: string,
    numCtx?: number,
  ): Promise<ChatMessage[] | 'too-short' | null> {
    const msgs = sessionMessages.filter((m) => (m.column ?? 'A') === column);
    if (msgs.length <= KEEP_RECENT + 2) return 'too-short';
    const older = msgs.slice(0, -KEEP_RECENT);
    const recent = msgs.slice(-KEEP_RECENT);
    const transcript = older
      .filter((m) => m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }));
    if (transcript.length === 0) return 'too-short';
    const r = await fetch('/api/sessions/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: transcript, ...(numCtx ? { numCtx } : {}) }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || 'Compaction failed');
    }
    const j = await r.json();
    if (typeof j.summary !== 'string' || !j.summary.trim()) throw new Error('Empty summary');
    const summaryMessage: ChatMessage = {
      id: safeUuid(),
      role: 'system',
      content: j.summary.trim(),
      createdAt: older[0]?.createdAt ?? Date.now(),
      model,
      sessionId: activeSessionId ?? undefined,
      ...(column === 'B' ? { column: 'B' as const } : {}),
    };
    return [summaryMessage, ...recent];
  }

  async function handleCompact(auto = false) {
    if (!activeSessionId || compacting || anyLoading) return;
    setCompacting(true);
    try {
      const snapshot = sessionMessages;
      const results: Partial<Record<'A' | 'B', ChatMessage[]>> = {};
      let tooShort = 0;
      let attempted = 0;
      if (columnA.model) {
        attempted++;
        const res = await compactColumn('A', columnA.model, numCtxA);
        if (res === 'too-short') tooShort++;
        else if (res) results.A = res;
      }
      if (compareMode && columnB.model) {
        attempted++;
        const res = await compactColumn('B', columnB.model, numCtxB);
        if (res === 'too-short') tooShort++;
        else if (res) results.B = res;
      }
      if (!attempted) return;
      if (!results.A && !results.B) {
        pushToast({
          type: 'info',
          title: 'Nothing to compact',
          message: `The conversation is still short — compaction keeps the last ${KEEP_RECENT} messages and needs some history beyond that.`,
        });
        return;
      }
      const next = [
        ...(results.A ?? sessionMessages.filter((m) => (m.column ?? 'A') === 'A')),
        ...(results.B ?? sessionMessages.filter((m) => (m.column ?? 'A') === 'B')),
      ];
      setSessionMessages(activeSessionId, next);
      persistSessionMessages(activeSessionId, next);
      setLastSnapshot(snapshot);
      if (undoTimeoutId) clearTimeout(undoTimeoutId);
      const id = setTimeout(() => setLastSnapshot(null), 15000);
      setUndoTimeoutId(id);
      pushToast({
        type: 'success',
        title: auto ? 'Context auto-compacted' : 'Context compacted',
        message: `${snapshot.length} messages → ${next.length}. Older history was replaced by a dense summary${tooShort ? ' (one column was too short and left untouched)' : ''}. Undo is available for 15s.`,
      });
    } catch (e) {
      pushToast({
        type: 'error',
        title: 'Compaction failed',
        message: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setCompacting(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const anyLoading = columnA.loading || (compareMode && columnB.loading);

  // Auto-compact: once a reply lands, check column A's REAL runtime context
  // usage (never the model's architectural max) against the threshold. A
  // cooldown prevents back-to-back auto-compactions from a single burst.
  const autoCompactEnabled = usePrefsStore((s) => s.autoCompactEnabled);
  const autoCompactThresholdPct = usePrefsStore((s) => s.autoCompactThresholdPct);
  const lastAutoCompactRef = useRef(0);
  useEffect(() => {
    if (!autoCompactEnabled || compacting || anyLoading) return;
    const limit = effectiveCtxA;
    if (!limit || lastPromptTokensA == null) return;
    const pct = (lastPromptTokensA / limit) * 100;
    if (pct < autoCompactThresholdPct) return;
    if (Date.now() - lastAutoCompactRef.current < 30_000) return;
    lastAutoCompactRef.current = Date.now();
    void handleCompact(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyLoading, autoCompactEnabled, autoCompactThresholdPct]);
  const activeModels = compareMode
    ? [columnA.model, columnB.model].filter(Boolean)
    : [columnA.model].filter(Boolean);
  const hasSub7b = activeModels.some((m) => /(^|[^0-9])([0-6](?:\.[0-9]+)?)b([^0-9]|$)/i.test(m));

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden glass-card">
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10 flex-wrap">
          <div className="flex bg-black/30 border border-white/10 rounded-full p-0.5 text-[11px] font-mono">
            <button
              type="button"
              onClick={() => setCompareMode(false)}
              className={`px-3 py-1 rounded-full transition ${
                !compareMode
                  ? 'bg-[rgb(var(--accent-glow)/0.22)] text-white shadow-[0_0_10px_-2px_rgb(var(--accent-glow)/0.5)]'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              Single
            </button>
            <button
              type="button"
              onClick={() => setCompareMode(true)}
              className={`px-3 py-1 rounded-full transition ${
                compareMode
                  ? 'bg-[rgb(var(--accent-glow)/0.22)] text-white shadow-[0_0_10px_-2px_rgb(var(--accent-glow)/0.5)]'
                  : 'text-white/40 hover:text-white/70'
              }`}
            >
              Compare
            </button>
          </div>

          <ModelSelect
            value={columnA.model}
            onChange={columnA.setModel}
            models={data?.models}
            placeholder="Select model"
          />
          <select
            value={activeSession?.profileId || ''}
            onChange={(e) =>
              activeSessionId &&
              patchSession(activeSessionId, { profileId: e.target.value || null })
            }
            title="Persona (system prompt) for this session"
            className="cap-pill border-white/15 bg-white/5 text-white/60 focus:outline-none"
          >
            <option value="">🧠 No persona</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id} className="bg-neutral-900">
                🧠 {p.name}
              </option>
            ))}
          </select>
          <CapabilityBadges capabilities={capsA} />
          <ContextBadge
            maxContext={contextLengthA}
            effectiveContext={effectiveCtxA}
            usedTokens={lastPromptTokensA}
          />
          <NumCtxControl model={columnA.model} maxContext={contextLengthA} />

          {compareMode && (
            <>
              <span className="text-white/20 text-xs">vs</span>
              <ModelSelect
                value={columnB.model}
                onChange={columnB.setModel}
                models={data?.models}
                placeholder="Select model B"
              />
              <CapabilityBadges capabilities={capsB} />
              <ContextBadge
                maxContext={contextLengthB}
                effectiveContext={effectiveCtxB}
                usedTokens={lastPromptTokensB}
              />
              <NumCtxControl model={columnB.model} maxContext={contextLengthB} />
            </>
          )}

          {toolsEnabled && (
            <span
              className={`cap-pill ${
                supportsToolsA === false
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200/80'
                  : 'border-cyan-500/25 bg-cyan-950/20 text-cyan-200/80'
              }`}
              title={
                supportsToolsA === false
                  ? 'Tools are enabled in Settings, but the selected model does not advertise tool support.'
                  : 'Web search + current date available to the model (configured in Settings).'
              }
            >
              {supportsToolsA === false ? (
                <>
                  <TriangleAlert className="h-3 w-3" /> tools unsupported
                </>
              ) : (
                <>
                  <Search className="h-3 w-3" /> tools active
                </>
              )}
            </span>
          )}

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setShowDebug((v) => !v)}
              title="Payload inspector"
              className={`h-7 w-7 grid place-items-center rounded-md text-xs transition ${
                showDebug
                  ? 'bg-white/15 text-white'
                  : 'text-white/40 hover:bg-white/10 hover:text-white/80'
              }`}
            >
              {'{ }'}
            </button>
          </div>
        </div>

        {hasSub7b && (
          <div className="mx-4 mt-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/80">
            Note: A selected sub‑7B model may only partially respect system prompts or ignore them.
          </div>
        )}

        {showDebug && (
          <div className="mx-4 mt-2 rounded-md border border-pink-500/30 bg-pink-500/5 p-3 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-auto">
            <div className="mb-1 text-pink-200/70">Last sent payload (A):</div>
            {JSON.stringify(columnA.lastPayload, null, 2)}
            {compareMode && (
              <>
                <div className="mt-2 mb-1 text-pink-200/70">Last sent payload (B):</div>
                {JSON.stringify(columnB.lastPayload, null, 2)}
              </>
            )}
          </div>
        )}

        {/* Trace columns */}
        <div ref={containerRef} className="flex-1 min-h-0 flex gap-3 px-4 pt-3">
          <ChatColumn
            messages={columnA.messages}
            streamingId={columnA.streamingId}
            coldStart={columnA.coldStart}
            coldElapsed={columnA.coldElapsed}
            emptyLabel={compareMode ? 'Column A — no messages yet.' : 'No messages yet.'}
            onRegenerate={() => regenerateColumn('A')}
            onDeletePair={(id) => deletePair('A', id)}
          />
          {compareMode && (
            <ChatColumn
              messages={columnB.messages}
              streamingId={columnB.streamingId}
              coldStart={columnB.coldStart}
              coldElapsed={columnB.coldElapsed}
              emptyLabel="Column B — no messages yet."
              onRegenerate={() => regenerateColumn('B')}
              onDeletePair={(id) => deletePair('B', id)}
            />
          )}
        </div>

        {/* Composer */}
        <div className="flex flex-col gap-2 px-4 pb-4 pt-3 border-t border-white/[0.06] bg-white/[0.015] mt-3">
          <div className="flex gap-2 flex-wrap">
            <span
              className={`cap-pill ${
                activePrompt.trim()
                  ? 'border-[rgb(var(--accent-glow)/0.3)] bg-[rgb(var(--accent-glow)/0.1)] text-white/75'
                  : 'border-white/10 bg-white/5 text-white/30'
              }`}
            >
              {activePrompt.trim() ? (
                <>
                  <Brain className="h-3 w-3 text-[rgb(var(--accent-glow)/0.9)]" />
                  {activeProfile?.name}
                </>
              ) : (
                'no persona'
              )}
            </span>
            <span
              className={`cap-pill ${
                toolsEnabled
                  ? 'border-cyan-500/25 bg-cyan-500/10 text-cyan-200/80'
                  : 'border-white/10 bg-white/5 text-white/30'
              }`}
            >
              {toolsEnabled ? (
                <>
                  <Search className="h-3 w-3" /> tools on
                </>
              ) : (
                'tools off'
              )}
            </span>
            <a
              href="/settings"
              className="text-[10px] text-white/30 hover:text-white/60 self-center underline"
            >
              change in Settings
            </a>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            placeholder={columnA.model ? 'Type a message…' : 'Select a model first'}
            className="min-h-[72px] rounded-xl border border-white/10 bg-black/25 px-3.5 py-2.5 text-sm text-white placeholder:text-white/25 transition-colors focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)] focus:ring-2 focus:ring-[rgb(var(--accent-glow)/0.3)]"
          />
          <div className="flex gap-2">
            <Button
              onClick={handleSend}
              size="sm"
              disabled={!input.trim() || !columnA.model || anyLoading}
              loading={anyLoading}
            >
              <span className="inline-flex items-center gap-1.5">
                <Send className="h-3.5 w-3.5" /> Send
              </span>
            </Button>
            {anyLoading && (
              <Button onClick={handleStop} size="sm" variant="danger">
                <span className="inline-flex items-center gap-1.5">
                  <Square className="h-3 w-3 fill-current" /> Stop
                </span>
              </Button>
            )}
            <Button
              onClick={() => handleCompact()}
              size="sm"
              variant="outline"
              disabled={anyLoading || compacting || sessionMessages.length === 0}
              loading={compacting}
              title={`Summarize older messages into a compact context note (keeps the last ${KEEP_RECENT} messages verbatim). Shrinks what is sent to the model.`}
            >
              <span className="inline-flex items-center gap-1.5">
                <FoldVertical className="h-3.5 w-3.5" /> Compact
              </span>
            </Button>
            {!pendingConfirm && (
              <Button
                onClick={() => setPendingConfirm(true)}
                size="sm"
                variant="secondary"
                disabled={anyLoading || sessionMessages.length === 0}
              >
                Clear history
              </Button>
            )}
            {pendingConfirm && (
              <div className="flex items-center gap-2 text-[11px]">
                <span className="text-white/50">Sure?</span>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setPendingConfirm(false);
                    setLastSnapshot(sessionMessages);
                    clear(activeSessionId || undefined);
                    if (activeSessionId) persistSessionMessages(activeSessionId, []);
                    if (undoTimeoutId) clearTimeout(undoTimeoutId);
                    const id = setTimeout(() => setLastSnapshot(null), 8000);
                    setUndoTimeoutId(id);
                  }}
                >
                  Yes
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setPendingConfirm(false)}>
                  No
                </Button>
              </div>
            )}
            {lastSnapshot && !pendingConfirm && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  restore(lastSnapshot, activeSessionId || undefined);
                  if (activeSessionId) persistSessionMessages(activeSessionId, lastSnapshot);
                  setLastSnapshot(null);
                  if (undoTimeoutId) clearTimeout(undoTimeoutId);
                }}
              >
                Undo
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
