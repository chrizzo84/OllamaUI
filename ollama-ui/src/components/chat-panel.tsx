'use client';
import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '@/store/chat';
import { useSystemPromptStore, LamaProfile } from '@/store/system-prompt';
import { useToolStore } from '@/store/tools';
import { toolSchemas, ToolName } from '@/lib/tools';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from './ui/button';
import { ToolSwitcher } from './tool-switcher';
import { useQuery } from '@tanstack/react-query';

interface ModelTag {
  name: string;
}
interface TagsResponse {
  models: ModelTag[];
}

async function fetchModels(): Promise<TagsResponse> {
  const r = await fetch('/api/models', { cache: 'no-store' });
  if (!r.ok) throw new Error('Model Load failed');
  return r.json();
}

export function ChatPanel() {
  const { data } = useQuery({ queryKey: ['ollama-model-tags'], queryFn: fetchModels });
  const [model, setModel] = useState<string>('');
  const [activeHost, setActiveHost] = useState<string | null>(null);

  // Load active host from /api/hosts
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

  // Restore model selection for active host
  useEffect(() => {
    if (!activeHost) return;
    try {
      const raw = localStorage.getItem('ollama_ui_selected_models');
      if (raw) {
        const map = JSON.parse(raw) as Record<string, string>;
        if (map[activeHost]) setModel(map[activeHost]);
      }
    } catch {
      /* ignore */
    }
  }, [activeHost, data]);

  // Persist model selection per host
  useEffect(() => {
    if (!activeHost || !model) return;
    try {
      const raw = localStorage.getItem('ollama_ui_selected_models');
      const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
      map[activeHost] = model;
      localStorage.setItem('ollama_ui_selected_models', JSON.stringify(map));
    } catch {
      /* ignore */
    }
  }, [model, activeHost]);
  const lamaState = useSystemPromptStore((s) => s);
  const { systemEnabled, setSystemEnabled } = lamaState;
  const {
    currentId,
    profiles,
    setCurrent,
    create,
    updatePrompt,
    remove,
    duplicate,
    resetPrompt,
    setTags,
    importProfiles,
    exportProfiles,
  } = lamaState;
  const activeProfile: LamaProfile | undefined = profiles.find(
    (p: LamaProfile) => p.id === currentId,
  );
  const activePrompt = activeProfile?.prompt || '';
  const [showSys, setShowSys] = useState(false);
  const [lamaDeleteConfirm, setLamaDeleteConfirm] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [lamaSearch, setLamaSearch] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  interface SentPayload {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    tools?: typeof toolSchemas;
  }
  const [lastPayload, setLastPayload] = useState<SentPayload | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const { toolSettings } = useToolStore();
  const [coldStart, setColdStart] = useState(false);
  const [coldStartSince, setColdStartSince] = useState<number | null>(null);
  const [coldElapsed, setColdElapsed] = useState(0);
  const allMessages = useChatStore((s) => s.messages);
  const messages = allMessages.filter((m) => m.profileId === currentId);
  const [expandedThinkIds, setExpandedThinkIds] = useState<Set<string>>(new Set());
  const append = useChatStore((s) => s.append);
  const update = useChatStore((s) => s.update);
  const clear = useChatStore((s) => s.clear);
  const restore = useChatStore((s) => s.restore);
  const tagUntagged = useChatStore((s) => s.tagUntagged);
  const [pendingConfirm, setPendingConfirm] = useState(false);
  const [lastSnapshot, setLastSnapshot] = useState<typeof messages | null>(null);
  const [undoTimeoutId, setUndoTimeoutId] = useState<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (!coldStart || !coldStartSince) return;
    const id = setInterval(() => {
      setColdElapsed(Math.floor((Date.now() - coldStartSince) / 1000));
    }, 500);
    return () => clearInterval(id);
  }, [coldStart, coldStartSince]);

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

  // ensure at least one profile exists for convenience
  useEffect(() => {
    // hydrate only once
    lamaState.hydrate?.();
  }, [lamaState]);

  useEffect(() => {
    // after hydration decide if a default profile must be created
    if (!lamaState.hydrated) return;
    if (profiles.length === 0) {
      create({ name: 'Default', prompt: '' });
    } else if (!currentId) {
      setCurrent(profiles[0].id);
    }
  }, [profiles, currentId, create, setCurrent, lamaState.hydrated]);

  async function send() {
    if (!input.trim() || !model) return;
    const userContent = input.trim();
    setInput('');
    append({ role: 'user', content: userContent, model, profileId: currentId || undefined });
    const assistantId = append({
      role: 'assistant',
      content: '',
      model,
      profileId: currentId || undefined,
    });
    const loaded = await isModelLoaded(model);
    if (!loaded) {
      setColdStart(true);
      setColdStartSince(Date.now());
      setColdElapsed(0);
    }
    setLoading(true);
    try {
      const current = useChatStore.getState().messages.filter((m) => m.profileId === currentId); // fresh state for this profile
      const upstreamMessages = [
        ...(systemEnabled && activePrompt.trim()
          ? [{ role: 'system' as const, content: activePrompt.trim() }]
          : []),
        ...current
          .filter((m) => m.role !== 'assistant' || m.content)
          .map((m) => ({ role: m.role, content: m.content })),
      ];
      // last user already included
      const enabledTools = toolSchemas.filter(
        (t) => toolSettings[t.function.name as ToolName],
      );
      const payload: SentPayload = {
        model,
        messages: upstreamMessages,
        ...(enabledTools.length > 0 && { tools: enabledTools }),
      };
      setLastPayload(payload);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.body) throw new Error('No body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let assistantRaw = '';
      // naive: replace last assistant message continuously
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (typeof obj.token === 'string') {
              assistantRaw += obj.token;
              if (coldStart) setColdStart(false);
            } else if (obj.done && typeof obj.content === 'string') {
              assistantRaw = obj.content; // final cumulative
            } else if (obj.error) {
              update(assistantId, { content: '[Fehler] ' + String(obj.error), raw: assistantRaw });
            }
            if (assistantRaw) {
                const display = assistantRaw;
                const isInThinkBlock =
                  display.startsWith('<think>') && !display.includes('</think>');

                update(assistantId, {
                  content: isInThinkBlock ? '…' : display,
                  raw: assistantRaw,
                });
              }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      update(assistantId, { content: '[Chat error]' });
    } finally {
      setLoading(false);
      setColdStart(false);
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  // migrate legacy messages (no profileId) to current profile when user selects one
  useEffect(() => {
    if (currentId) tagUntagged(currentId);
  }, [currentId, tagUntagged]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col gap-4 flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full sm:w-60 rounded-md border border-white/15 bg-white/10 px-2 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
        >
          <option value="" disabled>
            Select model
          </option>
          {data?.models.map((m) => (
            <option key={m.name} value={m.name} className="bg-neutral-900">
              {m.name}
            </option>
          ))}
        </select>
        {coldStart && (
          <div className="flex items-center gap-2 text-[11px] text-white/60 dark-green-model-loaded-indicator">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full dark-green-pill-ping"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full dark-green-pill"></span>
            </span>
            <span>Loading model… {coldElapsed}s</span>
          </div>
        )}
        {activePrompt.trim() && activeProfile && systemEnabled && (
          <span
            className="flex items-center text-[11px] px-3 py-2 rounded-md self-start max-w-[260px] truncate h-10 leading-none dark-green-model-indicator"
            title={activeProfile.name + ' active'}
          >
            <span className="font-semibold mr-2 dark-green-model-indicator-label">Profile:</span>
            <span className="truncate">{activeProfile.name}</span>
          </span>
        )}
      </div>
      <div className="-mt-1 flex gap-2 flex-wrap">
        <label
          className={`flex items-center gap-2 text-[11px] px-2.5 py-1.5 rounded-md border transition select-none min-w-[140px] justify-start
          ${systemEnabled ? 'bg-white/10 border-white/15 hover:border-white/25 hover:bg-white/15' : 'bg-white/5 border-white/10 opacity-70'}
        `}
        >
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-indigo-500 rounded-sm border border-white/30 bg-neutral-900"
            checked={systemEnabled}
            onChange={(e) => setSystemEnabled(e.target.checked)}
          />
          <span className="whitespace-nowrap leading-none">
            System prompt {systemEnabled ? 'enabled' : 'disabled'}
          </span>
        </label>
        {systemEnabled && (
          <Button
            type="button"
            size="sm"
            variant={showSys ? 'primary' : 'outline'}
            onClick={() => setShowSys((v) => !v)}
            className="flex-1 justify-start gap-2 min-w-[140px]"
          >
            <span>{showSys ? '🧠 Hide system prompt' : '🧠 Show system prompt'}</span>
            <span className="ml-auto text-[11px] opacity-80">{showSys ? '▲' : '▼'}</span>
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant={showDebug ? 'primary' : 'outline'}
          onClick={() => setShowDebug((v) => !v)}
          className="flex-1 justify-start gap-2 min-w-[140px]"
        >
          <span>{showDebug ? '🔍 Hide inspector' : '🔍 Payload Inspector'}</span>
          <span className="ml-auto text-[11px] opacity-80">{showDebug ? '▲' : '▼'}</span>
        </Button>
        <ToolSwitcher />
      </div>
      {model && /(^|[^0-9])([0-6](?:\.[0-9]+)?)b([^0-9]|$)/i.test(model) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/80">
          Note: This selected sub‑7B model may only partially respect system prompts or ignore them.
          For more reliable adherence choose a model ≥ 7B.
        </div>
      )}
      {showSys && systemEnabled && (
        <div className="rounded-md p-3 flex flex-col gap-3 dark-green-system-prompt-bg">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[11px] font-medium text-indigo-200/80">Profiles</span>
            <input
              value={lamaSearch}
              onChange={(e) => setLamaSearch(e.target.value)}
              placeholder="Search..."
              className="text-xs bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none"
            />
            <select
              value={currentId || ''}
              onChange={(e) => setCurrent(e.target.value || null)}
              className="text-xs bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none"
            >
              {profiles
                .filter((p: LamaProfile) => {
                  if (!lamaSearch.trim()) return true;
                  const q = lamaSearch.toLowerCase();
                  return (
                    p.name.toLowerCase().includes(q) ||
                    (p.tags || []).some((t) => t.toLowerCase().includes(q))
                  );
                })
                .map((p: LamaProfile) => (
                  <option key={p.id} value={p.id} className="bg-neutral-900">
                    {p.name}
                  </option>
                ))}
            </select>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const id = create({ name: 'New', prompt: '' });
                setCurrent(id);
                setEditingName(true);
              }}
            >
              + New
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const data = exportProfiles();
                const blob = new Blob([JSON.stringify(data, null, 2)], {
                  type: 'application/json',
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'lamas.json';
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export
            </Button>
            <>
              <input
                id="lama-import-input"
                type="file"
                accept="application/json"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const txt = await file.text();
                    const json = JSON.parse(txt);
                    type ImportLike = {
                      id?: string;
                      name?: string;
                      prompt?: string;
                      tags?: unknown;
                      updatedAt?: number;
                    };
                    const normalize = (arr: unknown[]): ImportLike[] =>
                      arr.filter((x): x is ImportLike => !!x && typeof x === 'object');
                    const adapt = (arr: ImportLike[]) =>
                      arr.map((o) => ({
                        name: o.name || 'Import',
                        prompt: o.prompt || '',
                        tags: Array.isArray(o.tags)
                          ? o.tags.filter((t) => typeof t === 'string').slice(0, 20)
                          : [],
                      }));
                    if (Array.isArray(json)) {
                      importProfiles(adapt(normalize(json)));
                    } else if (
                      typeof json === 'object' &&
                      json &&
                      Array.isArray((json as { profiles?: unknown }).profiles)
                    ) {
                      importProfiles(adapt(normalize((json as { profiles: unknown[] }).profiles)));
                    }
                  } catch {
                    /* ignore */
                  }
                  e.target.value = '';
                }}
              />
              <Button
                size="sm"
                variant="outline"
                type="button"
                onClick={() => document.getElementById('lama-import-input')?.click()}
              >
                Import
              </Button>
            </>
            {currentId && (
              <Button size="sm" variant="outline" onClick={() => duplicate(currentId)}>
                Duplicate
              </Button>
            )}
            {currentId && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (lamaDeleteConfirm === currentId) {
                    remove(currentId);
                    setLamaDeleteConfirm(null);
                  } else {
                    setLamaDeleteConfirm(currentId);
                    setTimeout(() => setLamaDeleteConfirm(null), 4000);
                  }
                }}
              >
                {lamaDeleteConfirm === currentId ? 'Sure?' : 'Delete'}
              </Button>
            )}
            {currentId && activePrompt && (
              <Button size="sm" variant="outline" onClick={() => resetPrompt(currentId)}>
                Clear prompt
              </Button>
            )}
          </div>
          {activeProfile && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {editingName ? (
                  <input
                    value={activeProfile.name}
                    onChange={(e) => updatePrompt(activeProfile.id, { name: e.target.value })}
                    onBlur={() => setEditingName(false)}
                    className="text-xs bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none"
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setEditingName(true)}
                    className="text-left text-xs font-medium text-indigo-100 hover:underline"
                    title="Edit name"
                  >
                    {activeProfile.name}
                  </button>
                )}
                <span className="text-[10px] text-white/30">
                  {new Date(activeProfile.updatedAt).toLocaleTimeString()}
                </span>
              </div>
              <textarea
                value={activePrompt}
                onChange={(e) => updatePrompt(activeProfile.id, { prompt: e.target.value })}
                placeholder="System instruction for this profile..."
                className="min-h-[90px] rounded-md border border-white/15 bg-white/10 px-2 py-2 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const raw = tagInput.trim();
                        if (!raw) return;
                        const tags = Array.from(
                          new Set([
                            ...(activeProfile.tags || []),
                            ...raw
                              .split(',')
                              .map((t) => t.trim())
                              .filter(Boolean),
                          ]),
                        ).slice(0, 20);
                        setTags(activeProfile.id, tags);
                        setTagInput('');
                      }
                      if (e.key === 'Backspace' && !tagInput) {
                        // remove last
                        const current = activeProfile.tags || [];
                        if (current.length > 0) {
                          setTags(activeProfile.id, current.slice(0, current.length - 1));
                        }
                      }
                    }}
                    placeholder="Enter tag + Enter"
                    className="text-xs bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none flex-1"
                  />
                  {activeProfile.tags && activeProfile.tags.length > 0 && (
                    <button
                      type="button"
                      title="Remove all tags"
                      onClick={() => setTags(activeProfile.id, [])}
                      className="text-[10px] px-2 py-1 rounded border border-white/15 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white/80 transition"
                    >
                      Reset
                    </button>
                  )}
                </div>
                {activeProfile.tags && activeProfile.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {activeProfile.tags.map((t) => (
                      <button
                        key={t}
                        type="button"
                        onClick={() =>
                          setTags(
                            activeProfile.id,
                            (activeProfile.tags || []).filter((x) => x !== t),
                          )
                        }
                        className="group text-[10px] px-2 py-0.5 rounded bg-white/10 border border-white/15 text-white/70 hover:bg-pink-500/20 hover:border-pink-500/40 hover:text-white flex items-center gap-1"
                        title="Remove tag"
                      >
                        {t}
                        <span className="opacity-0 group-hover:opacity-80 transition">×</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="text-[10px] text-white/40 flex justify-between">
                <span>{activePrompt.trim().length} characters</span>
                {activePrompt && <span>prepended to every request</span>}
              </div>
              {activePrompt.trim().length > 8000 && (
                <div className="text-[10px] text-amber-300/80 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                  Warning: Very long prompt – risk of token/context truncation.
                </div>
              )}
            </div>
          )}
          {!activeProfile && <div className="text-[11px] text-white/40">No profile selected.</div>}
        </div>
      )}
      {showDebug && lastPayload && (
        <div className="rounded-md border border-pink-500/30 bg-pink-500/5 p-3 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-auto">
          <div className="mb-1 text-pink-200/70">Last sent payload:</div>
          {JSON.stringify(lastPayload, null, 2)}
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto rounded-md bg-black/30 p-3 text-sm space-y-3"
      >
        {messages.length === 0 && <div className="text-white/40 text-xs">No messages yet.</div>}
        {messages.map((m) => {
          console.log('Rendering message:', { id: m.id, content: m.content, raw: m.raw });
          const isUser = m.role === 'user';
          const hasThink =
            !isUser && typeof m.raw === 'string' && /<think>[\s\S]*?<\/think>/.test(m.raw);
          const expanded = expandedThinkIds.has(m.id);
          let thinkContent: string | null = null;
          if (hasThink) {
            const match = m.raw!.match(/<think>[\s\S]*?<\/think>/);
            if (match) thinkContent = match[0].replace(/<\/?think>/g, '').trim();
          }
          const toggle = () =>
            setExpandedThinkIds((prev) => {
              const next = new Set(prev);
              if (next.has(m.id)) next.delete(m.id);
              else next.add(m.id);
              return next;
            });
          return (
            <div
              key={m.id}
              className={`rounded-md px-3 py-2 leading-relaxed text-sm border ${
                isUser
                  ? 'bg-indigo-500/20 border-indigo-500/30 dark-green-chat-user'
                  : 'bg-white/10 border-white/10'
              }`}
            >
              <div className="text-[10px] uppercase tracking-wide mb-1 text-white/40">{m.role}</div>
              {isUser ? (
                <div className="whitespace-pre-wrap text-white/90 font-light dark-green-chat-user-text">
                  {m.content}
                </div>
              ) : (
                <div className="space-y-3">
                  {hasThink && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200/80">
                      {expanded && thinkContent ? (
                        <div className="whitespace-pre-wrap mb-2 opacity-90">{thinkContent}</div>
                      ) : (
                        <div className="italic opacity-70">Hidden reasoning collapsed</div>
                      )}
                      <button
                        type="button"
                        onClick={toggle}
                        className="mt-1 rounded bg-amber-500/20 px-2 py-1 text-[10px] font-medium text-amber-100 hover:bg-amber-500/30 transition"
                      >
                        {expanded ? 'Hide reasoning' : 'Show reasoning'}
                      </button>
                    </div>
                  )}
                  {(() => {
                    const displayContent = (m.content || '')
                      .replace(/<think>[\s\S]*?<\/think>/, '')
                      .trim();
                    return m.content === '…' || (m.raw?.startsWith('<think>') && !displayContent) ? (
                      <div className="flex items-center gap-1 h-6">
                        <span className="animate-bounce [animation-delay:-0.25s]">🦙</span>
                        <span className="animate-bounce [animation-delay:-0.15s]">🦙</span>
                        <span className="animate-bounce [animation-delay:-0.05s]">🦙</span>
                      </div>
                    ) : (
                      <div className="prose prose-invert max-w-none text-white/90 prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-pre:my-3 prose-code:px-1 prose-code:py-0.5 prose-code:bg-white/10 prose-code:rounded">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {displayContent || '…'}
                        </ReactMarkdown>
                      </div>
                    );
                  })()}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex flex-col gap-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder={model ? 'Type a message…' : 'Select a model first'}
          className="min-h-[80px] rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
        />
        <div className="flex gap-2">
          <Button
            onClick={send}
            size="sm"
            disabled={!input.trim() || !model || loading}
            loading={loading}
          >
            Send
          </Button>
          {!pendingConfirm && (
            <Button
              onClick={() => setPendingConfirm(true)}
              size="sm"
              variant="secondary"
              disabled={loading || messages.length === 0}
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
                  setLastSnapshot(messages);
                  clear(currentId || undefined);
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
                restore(lastSnapshot, currentId || undefined);
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
  );
}
