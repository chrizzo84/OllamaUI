'use client';
import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '@/store/chat';
import { useSystemPromptStore, LamaProfile } from '@/store/system-prompt';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from './ui/button';
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
  const lamaState = useSystemPromptStore((s) => s);
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
  const [tagEdit, setTagEdit] = useState('');
  const [showDebug, setShowDebug] = useState(false);
  interface SentPayload {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  }
  const [lastPayload, setLastPayload] = useState<SentPayload | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [coldStart, setColdStart] = useState(false);
  const [coldStartSince, setColdStartSince] = useState<number | null>(null);
  const [coldElapsed, setColdElapsed] = useState(0);
  const messages = useChatStore((s) => s.messages);
  const [expandedThinkIds, setExpandedThinkIds] = useState<Set<string>>(new Set());
  const append = useChatStore((s) => s.append);
  const update = useChatStore((s) => s.update);
  const clear = useChatStore((s) => s.clear);
  const restore = useChatStore(
    (s) => (s as unknown as { restore: (m: typeof messages) => void }).restore,
  );
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
      if (!r.ok) return true;
      const j = (await r.json()) as { models?: Array<{ name?: string; model?: string }> };
      if (!j.models) return true;
      return j.models.some((m) => m.name === target || m.model === target.split(':')[0]);
    } catch {
      return true;
    }
  }

  // ensure at least one profile exists for convenience
  useEffect(() => {
    if (profiles.length === 0) {
      create({ name: 'Standard', prompt: '' });
    } else if (!currentId) {
      setCurrent(profiles[0].id);
    }
  }, [profiles, currentId, create, setCurrent]);

  async function send() {
    if (!input.trim() || !model) return;
    const userContent = input.trim();
    setInput('');
    append({ role: 'user', content: userContent, model });
    const assistantId = append({ role: 'assistant', content: '', model });
    const loaded = await isModelLoaded(model);
    if (!loaded) {
      setColdStart(true);
      setColdStartSince(Date.now());
      setColdElapsed(0);
    }
    setLoading(true);
    try {
      const current = useChatStore.getState().messages; // fresh state
      const upstreamMessages = [
        ...(activePrompt.trim() ? [{ role: 'system' as const, content: activePrompt.trim() }] : []),
        ...current
          .filter((m) => m.role !== 'assistant' || m.content) // skip empty assistant placeholders
          .map((m) => ({ role: m.role, content: m.content })),
      ];
      // last user already included
      const payload = { model, messages: upstreamMessages };
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
              let display = assistantRaw;
              if (assistantRaw.startsWith('<think>')) {
                const closeIdx = assistantRaw.indexOf('</think>');
                if (closeIdx === -1) {
                  // still thinking, hide content
                  display = '';
                } else {
                  const after = assistantRaw.slice(closeIdx + 8).trim();
                  display = after;
                }
              }
              update(assistantId, {
                content: display && display.length > 0 ? display : '…',
                raw: assistantRaw,
              });
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      update(assistantId, { content: '[Fehler beim Chat]' });
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

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col gap-4 flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full sm:w-60 rounded-md border border-white/15 bg-white/10 px-2 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
        >
          <option value="" disabled>
            Modell wählen
          </option>
          {data?.models.map((m) => (
            <option key={m.name} value={m.name} className="bg-neutral-900">
              {m.name}
            </option>
          ))}
        </select>
        {coldStart && (
          <div className="flex items-center gap-2 text-[11px] text-white/60">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-300"></span>
            </span>
            <span>Modell wird geladen… {coldElapsed}s</span>
          </div>
        )}
        <button
          type="button"
          onClick={() => setShowSys((v) => !v)}
          className="text-[10px] uppercase tracking-wide text-white/50 hover:text-white/80 transition underline-offset-2 hover:underline"
        >
          {showSys ? 'System-Prompt verbergen' : 'System-Prompt anzeigen'}
        </button>
        {activePrompt.trim() && (
          <span className="text-[10px] px-2 py-0.5 rounded bg-indigo-500/20 border border-indigo-500/30 text-indigo-200/80 self-start">
            Lama aktiv
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowDebug((v) => !v)}
          className="text-[10px] ml-auto px-2 py-0.5 rounded border border-white/10 hover:border-white/20 bg-white/5 text-white/50 hover:text-white/80 transition"
        >
          {showDebug ? 'Debug aus' : 'Debug an'}
        </button>
      </div>
      {model && /(^|[^0-9])1b([^0-9]|$)/i.test(model) && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200/80">
          Hinweis: Dieses ausgewählte 1B‑Modell beachtet System-Prompts häufig nur teilweise oder
          gar nicht. Für verlässlichere Einhaltung bitte ein Modell ≥ 7B wählen.
        </div>
      )}
      {showSys && (
        <div className="rounded-md border border-indigo-500/30 bg-indigo-500/5 p-3 flex flex-col gap-3">
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[11px] font-medium text-indigo-200/80">Lamas</span>
            <input
              value={lamaSearch}
              onChange={(e) => setLamaSearch(e.target.value)}
              placeholder="Suchen..."
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
                const id = create({ name: 'Neu', prompt: '' });
                setCurrent(id);
                setEditingName(true);
              }}
            >
              + Neu
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
            <label className="text-[10px] px-2 py-1 rounded border border-white/15 bg-white/10 cursor-pointer hover:bg-white/20 transition">
              <input
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
              Import
            </label>
            {currentId && (
              <Button size="sm" variant="outline" onClick={() => duplicate(currentId)}>
                Duplizieren
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
                {lamaDeleteConfirm === currentId ? 'Sicher?' : 'Löschen'}
              </Button>
            )}
            {currentId && activePrompt && (
              <Button size="sm" variant="outline" onClick={() => resetPrompt(currentId)}>
                Prompt leeren
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
                    title="Namen bearbeiten"
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
                placeholder="System-Anweisung für dieses Lama..."
                className="min-h-[90px] rounded-md border border-white/15 bg-white/10 px-2 py-2 text-xs text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
              <input
                value={tagEdit}
                onChange={(e) => setTagEdit(e.target.value)}
                onBlur={() => {
                  const tags = tagEdit
                    .split(',')
                    .map((t) => t.trim())
                    .filter(Boolean)
                    .slice(0, 10);
                  setTags(activeProfile.id, tags);
                }}
                placeholder="Tags (kommagetrennt)"
                className="text-xs bg-white/10 border border-white/15 rounded px-2 py-1 text-white focus:outline-none"
              />
              {activeProfile.tags && activeProfile.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {activeProfile.tags.map((t) => (
                    <span
                      key={t}
                      className="text-[10px] px-2 py-0.5 rounded bg-white/10 border border-white/15 text-white/70"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}
              <div className="text-[10px] text-white/40 flex justify-between">
                <span>{activePrompt.trim().length} Zeichen</span>
                {activePrompt && <span>wird jeder Anfrage vorangestellt</span>}
              </div>
              {activePrompt.trim().length > 8000 && (
                <div className="text-[10px] text-amber-300/80 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-1">
                  Warnung: Sehr langer Prompt – Risiko von Token- / Kontext-Trunkierung.
                </div>
              )}
            </div>
          )}
          {!activeProfile && <div className="text-[11px] text-white/40">Kein Lama ausgewählt.</div>}
        </div>
      )}
      {showDebug && lastPayload && (
        <div className="rounded-md border border-pink-500/30 bg-pink-500/5 p-3 text-[11px] font-mono whitespace-pre-wrap max-h-40 overflow-auto">
          <div className="mb-1 text-pink-200/70">Letzter gesendeter Payload:</div>
          {JSON.stringify(lastPayload, null, 2)}
        </div>
      )}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto rounded-md bg-black/30 p-3 text-sm space-y-3"
      >
        {messages.length === 0 && (
          <div className="text-white/40 text-xs">Noch keine Nachrichten.</div>
        )}
        {messages.map((m) => {
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
                isUser ? 'bg-indigo-500/20 border-indigo-500/30' : 'bg-white/10 border-white/10'
              }`}
            >
              <div className="text-[10px] uppercase tracking-wide mb-1 text-white/40">{m.role}</div>
              {isUser ? (
                <div className="whitespace-pre-wrap text-white/90 font-light">{m.content}</div>
              ) : (
                <div className="space-y-3">
                  {hasThink && (
                    <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-200/80">
                      {expanded && thinkContent ? (
                        <div className="whitespace-pre-wrap mb-2 opacity-90">{thinkContent}</div>
                      ) : (
                        <div className="italic opacity-70">Versteckte Gedanken verborgen</div>
                      )}
                      <button
                        type="button"
                        onClick={toggle}
                        className="mt-1 rounded bg-amber-500/20 px-2 py-1 text-[10px] font-medium text-amber-100 hover:bg-amber-500/30 transition"
                      >
                        {expanded ? 'Gedanken verstecken' : 'Gedanken anzeigen'}
                      </button>
                    </div>
                  )}
                  <div className="prose prose-invert max-w-none text-white/90 prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-pre:my-3 prose-code:px-1 prose-code:py-0.5 prose-code:bg-white/10 prose-code:rounded">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || '…'}</ReactMarkdown>
                  </div>
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
          placeholder={model ? 'Nachricht eingeben…' : 'Erst Modell wählen'}
          className="min-h-[80px] rounded-md border border-white/15 bg-white/10 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
        />
        <div className="flex gap-2">
          <Button
            onClick={send}
            size="sm"
            disabled={!input.trim() || !model || loading}
            loading={loading}
          >
            Senden
          </Button>
          {!pendingConfirm && (
            <Button
              onClick={() => setPendingConfirm(true)}
              size="sm"
              variant="secondary"
              disabled={loading || messages.length === 0}
            >
              Verlauf löschen
            </Button>
          )}
          {pendingConfirm && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-white/50">Sicher?</span>
              <Button
                size="sm"
                variant="danger"
                onClick={() => {
                  setPendingConfirm(false);
                  setLastSnapshot(messages);
                  clear();
                  if (undoTimeoutId) clearTimeout(undoTimeoutId);
                  const id = setTimeout(() => setLastSnapshot(null), 8000);
                  setUndoTimeoutId(id);
                }}
              >
                Ja
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setPendingConfirm(false)}>
                Nein
              </Button>
            </div>
          )}
          {lastSnapshot && !pendingConfirm && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                restore(lastSnapshot);
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
