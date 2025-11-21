'use client';
import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from './ui/button';
import { useQuery } from '@tanstack/react-query';

// Duplicating this here for now to make the component self-contained
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  raw?: string;
  createdAt: number;
  model?: string;
}

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

export interface SingleChatViewProps {
  messages: ChatMessage[];
  model: string;
  onModelChange: (model: string) => void;
  onSend: (message: string) => void;
  loading: boolean;
  clear: () => void;
  temperature: number;
  seed?: number;
  onOptionsChange: (options: { temperature?: number; seed?: number }) => void;
}

export function SingleChatView({
  messages,
  model,
  onModelChange,
  onSend,
  loading,
  clear,
  temperature,
  seed,
  onOptionsChange,
}: SingleChatViewProps) {
  const { data } = useQuery({ queryKey: ['ollama-model-tags'], queryFn: fetchModels });
  const [input, setInput] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleSend() {
    if (!input.trim() || !model) return;
    onSend(input.trim());
    setInput('');
  }

  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col gap-4 flex-1 min-h-0 overflow-hidden">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
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
        </div>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex items-center gap-2">
            <label htmlFor="temp" className="w-20">
              Temp:
            </label>
            <input
              id="temp"
              type="range"
              min="0"
              max="1"
              step="0.1"
              value={temperature}
              onChange={(e) => onOptionsChange({ temperature: parseFloat(e.target.value) })}
              className="w-full"
            />
            <span>{temperature.toFixed(1)}</span>
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="seed" className="w-20">
              Seed:
            </label>
            <input
              id="seed"
              type="number"
              value={seed || ''}
              onChange={(e) =>
                onOptionsChange({ seed: e.target.value ? parseInt(e.target.value, 10) : undefined })
              }
              placeholder="Optional"
              className="w-full rounded-md border border-white/15 bg-white/10 px-2 py-1 text-sm text-white focus:outline-none"
            />
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto rounded-md bg-black/30 p-3 text-sm space-y-3"
      >
        {messages.length === 0 && <div className="text-white/40 text-xs">No messages yet.</div>}
        {messages.map((m) => {
          const isUser = m.role === 'user';
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
                  {m.content === '…' ? (
                    <div className="flex items-center gap-1 h-6">
                      <span className="animate-bounce [animation-delay:-0.25s]">🦙</span>
                      <span className="animate-bounce [animation-delay:-0.15s]">🦙</span>
                      <span className="animate-bounce [animation-delay:-0.05s]">🦙</span>
                    </div>
                  ) : (
                    <div className="prose prose-invert max-w-none text-white/90 prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-pre:my-3 prose-code:px-1 prose-code:py-0.5 prose-code:bg-white/10 prose-code:rounded">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content || '…'}</ReactMarkdown>
                    </div>
                  )}
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
            onClick={handleSend}
            size="sm"
            disabled={!input.trim() || !model || loading}
            loading={loading}
          >
            Send
          </Button>
          <Button
            onClick={clear}
            size="sm"
            variant="secondary"
            disabled={loading || messages.length === 0}
          >
            Clear history
          </Button>
        </div>
      </div>
    </div>
  );
}
