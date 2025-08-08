'use client';
import { useState, useRef, useEffect } from 'react';
import { useChatStore } from '@/store/chat';
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
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [coldStart, setColdStart] = useState(false);
  const [coldStartSince, setColdStartSince] = useState<number | null>(null);
  const [coldElapsed, setColdElapsed] = useState(0);
  const messages = useChatStore((s) => s.messages);
  const [expandedThinkIds, setExpandedThinkIds] = useState<Set<string>>(new Set());
  const append = useChatStore((s) => s.append);
  const update = useChatStore((s) => s.update);
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
      const upstreamMessages = current
        .filter((m) => m.role !== 'assistant' || m.content) // skip empty assistant placeholders
        .map((m) => ({ role: m.role, content: m.content }));
      // last user already included
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: upstreamMessages }),
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
    <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col gap-4">
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
      </div>
      <div
        ref={containerRef}
        className="h-72 overflow-auto rounded-md bg-black/30 p-3 text-sm space-y-3"
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
        </div>
      </div>
    </div>
  );
}
