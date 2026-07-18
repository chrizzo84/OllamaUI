'use client';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useChatStore } from '@/store/chat';
import { useSystemPromptStore } from '@/store/system-prompt';
import { useToolsStore } from '@/store/tools';
import { useSessionsStore, loadSessionMessages, persistSessionMessages } from '@/store/sessions';
import { useColumnChat } from '@/hooks/use-column-chat';
import { ChatColumn } from './chat-column';
import { Button } from './ui/button';
import { hasCapability } from '@/lib/utils';

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

function CapabilityBadges({ capabilities }: { capabilities: string[] | undefined }) {
  if (!capabilities) return null;
  return (
    <>
      {hasCapability(capabilities, 'thinking') && (
        <span className="cap-pill border-amber-500/30 bg-amber-500/10 text-amber-300/90">
          ◆ thinking
        </span>
      )}
      {hasCapability(capabilities, 'tools') && (
        <span className="cap-pill border-cyan-500/30 bg-cyan-500/10 text-cyan-300/90">
          🔧 tools
        </span>
      )}
    </>
  );
}

function ContextBadge({
  contextLength,
  usedTokens,
}: {
  contextLength: number | undefined;
  usedTokens: number | undefined;
}) {
  if (!contextLength) return null;
  const pct =
    usedTokens != null ? Math.min(100, Math.round((usedTokens / contextLength) * 100)) : null;
  return (
    <span
      className={`cap-pill ${
        pct != null && pct >= 80
          ? 'border-amber-500/30 bg-amber-500/10 text-amber-300/90'
          : 'border-white/15 bg-white/5 text-white/45'
      }`}
      title={
        usedTokens != null
          ? `~${usedTokens} of ${contextLength} context tokens used (based on the last request)`
          : `Context window: ${contextLength} tokens`
      }
    >
      {usedTokens != null
        ? `${formatTokenCount(usedTokens)}/${formatTokenCount(contextLength)} ctx`
        : `${formatTokenCount(contextLength)} ctx`}
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
      className="rounded-md border border-white/15 bg-white/10 px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
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

  const contextLengthA = data?.models.find((m) => m.name === columnA.model)?.details
    ?.context_length;
  const contextLengthB = data?.models.find((m) => m.name === columnB.model)?.details
    ?.context_length;
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
    const jobs = [columnA.send(text, opts)];
    if (compareMode && columnB.model) jobs.push(columnB.send(text, opts));
    await Promise.all(jobs);
  }

  function handleStop() {
    columnA.stop();
    if (compareMode) columnB.stop();
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  const anyLoading = columnA.loading || (compareMode && columnB.loading);
  const activeModels = compareMode
    ? [columnA.model, columnB.model].filter(Boolean)
    : [columnA.model].filter(Boolean);
  const hasSub7b = activeModels.some((m) => /(^|[^0-9])([0-6](?:\.[0-9]+)?)b([^0-9]|$)/i.test(m));

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden rounded-xl border border-white/10 bg-white/5">
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-white/10 flex-wrap">
          <div className="flex bg-black/30 border border-white/10 rounded-full p-0.5 text-[11px] font-mono">
            <button
              type="button"
              onClick={() => setCompareMode(false)}
              className={`px-3 py-1 rounded-full transition ${
                !compareMode
                  ? 'bg-indigo-500/20 text-indigo-200'
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
                  ? 'bg-indigo-500/20 text-indigo-200'
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
          <ContextBadge contextLength={contextLengthA} usedTokens={lastPromptTokensA} />

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
              <ContextBadge contextLength={contextLengthB} usedTokens={lastPromptTokensB} />
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
              {supportsToolsA === false ? '⚠️ tools unsupported' : '🔎🗓️ tools active'}
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
          />
          {compareMode && (
            <ChatColumn
              messages={columnB.messages}
              streamingId={columnB.streamingId}
              coldStart={columnB.coldStart}
              coldElapsed={columnB.coldElapsed}
              emptyLabel="Column B — no messages yet."
            />
          )}
        </div>

        {/* Composer */}
        <div className="flex flex-col gap-2 px-4 pb-4 pt-3">
          <div className="flex gap-2 flex-wrap">
            <span
              className={`cap-pill ${
                activePrompt.trim()
                  ? 'border-indigo-500/25 bg-indigo-500/10 text-indigo-200/80'
                  : 'border-white/10 bg-white/5 text-white/30'
              }`}
            >
              {activePrompt.trim() ? `🧠 ${activeProfile?.name}` : 'no persona'}
            </span>
            <span
              className={`cap-pill ${
                toolsEnabled
                  ? 'border-cyan-500/25 bg-cyan-500/10 text-cyan-200/80'
                  : 'border-white/10 bg-white/5 text-white/30'
              }`}
            >
              {toolsEnabled ? '🔎 tools on' : 'tools off'}
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
            className="min-h-[72px] rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
          />
          <div className="flex gap-2">
            <Button
              onClick={handleSend}
              size="sm"
              disabled={!input.trim() || !columnA.model || anyLoading}
              loading={anyLoading}
            >
              Send
            </Button>
            {anyLoading && (
              <Button onClick={handleStop} size="sm" variant="danger">
                Stop
              </Button>
            )}
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
