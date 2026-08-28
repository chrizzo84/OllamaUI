'use client';
import {
  isValidElement,
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import {
  Brain,
  Search,
  ChevronDown,
  ChevronUp,
  FoldVertical,
  Copy,
  Check,
  RefreshCw,
  Trash2,
  AlertTriangle,
  Wrench,
  Pencil,
  X,
} from 'lucide-react';
import { ChatMessage, TraceEvent } from '@/store/chat';
import { useToastStore } from '@/store/toast';
import {
  looksLikePseudoToolCall,
  parsePseudoToolCall,
  renderPseudoToolCallAsMarkdown,
} from '@/lib/pseudo-tool-call';

// Shown instead of the raw, ugly tag soup while a model streams an
// unsupported pseudo tool-call (see lib/pseudo-tool-call.ts) — ticks so it's
// visibly alive instead of looking frozen.
function PseudoToolCallIndicator() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="flex items-center gap-1.5 text-cyan-200/70 text-xs">
      <Wrench className="h-3.5 w-3.5 animate-pulse" />
      <span>Model is attempting an unsupported tool call — cleaning up… {elapsed}s</span>
    </div>
  );
}

// Best-effort extraction of the raw text inside a <pre><code>...</code></pre>
// block as rendered by react-markdown, so the copy button copies exactly
// what's shown regardless of how deeply the text node is nested.
function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return extractText(node.props.children);
  return '';
}

// react-markdown renders fenced code blocks as <pre><code>...</code></pre>;
// override <pre> to add a hover copy button for the block's raw content.
function CodeBlockPre(props: React.ComponentPropsWithoutRef<'pre'>) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    const text = extractText(props.children).replace(/\n$/, '');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — silently ignore, matches other copy actions */
    }
  }

  return (
    <div className="group/code relative">
      <pre {...props} />
      <button
        type="button"
        onClick={handleCopy}
        title="Copy code"
        className="absolute right-2 top-2 flex items-center gap-1 rounded-md border border-white/15 bg-black/60 px-2 py-1 text-[10px] text-white/60 opacity-0 backdrop-blur transition hover:border-white/30 hover:text-white group-hover/code:opacity-100"
      >
        {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

interface ChatColumnProps {
  messages: ChatMessage[];
  streamingId: string | null;
  coldStart: boolean;
  coldElapsed: number;
  // Heads-up only (see the `queued` wire event) — N other job(s) were
  // already running against the same model when this one started. Not a
  // guarantee this one is actually waiting on them; just an honest reason to
  // show instead of leaving a silent "Thinking…" during what might be a long
  // wait for Ollama to get to this request.
  queuedAhead?: number | null;
  emptyLabel?: string;
  onRegenerate?: () => void; // only offered for the last assistant message
  onDeletePair?: (assistantMessageId: string) => void;
  // Editing a user message truncates everything after it and resends the
  // edited text — see editMessage in chat-panel.tsx.
  onEditMessage?: (userMessageId: string, newText: string) => void;
}

function ThinkingLine({
  ev,
  expanded,
  active,
  onToggle,
}: {
  ev: Extract<TraceEvent, { type: 'thinking' }>;
  expanded: boolean;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-amber-500/25 bg-amber-950/30 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-amber-200/70 hover:text-amber-200 hover:bg-amber-500/10 transition text-left"
      >
        <Brain className="h-3 w-3 text-amber-400/70 shrink-0" />
        <span className="font-medium">Reasoning</span>
        {active && <span className="text-amber-400/70 animate-pulse font-normal">thinking…</span>}
        <span className="ml-auto opacity-50 flex items-center gap-1 text-[10px]">
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? 'hide' : 'show'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 max-h-56 overflow-y-auto border-t border-amber-500/15">
          <div className="pt-2 text-[11px] text-amber-100/55 font-mono whitespace-pre-wrap leading-relaxed">
            {ev.text}
          </div>
        </div>
      )}
    </div>
  );
}

function ToolLine({
  ev,
  expanded,
  onToggle,
}: {
  ev: Extract<TraceEvent, { type: 'tool' }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const pending = ev.result === undefined && ev.error === undefined;
  const searchResults =
    ev.result && typeof ev.result === 'object' && 'results' in ev.result
      ? ((ev.result as { results?: Array<{ title?: string; url?: string; snippet?: string }> })
          .results ?? [])
      : [];
  const query =
    ev.arguments && typeof ev.arguments === 'object' && 'query' in ev.arguments
      ? String((ev.arguments as { query?: unknown }).query ?? '')
      : '';
  // remember_fact is a background utility call, not something the user needs
  // to expand/collapse to understand — show what got saved directly, per the
  // "give a hint when memory is active" requirement.
  if (ev.name === 'remember_fact') {
    const fact =
      ev.arguments && typeof ev.arguments === 'object' && 'fact' in ev.arguments
        ? String((ev.arguments as { fact?: unknown }).fact ?? '')
        : '';
    return (
      <div className="flex items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-950/20 px-3 py-2 text-[11px] text-violet-200/80">
        <Brain className="h-3 w-3 text-violet-400/70 shrink-0" />
        <span>
          {ev.error ? `Couldn't save to memory: ${ev.error}` : `Saved to memory: "${fact}"`}
        </span>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-cyan-500/25 bg-cyan-950/20 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-cyan-200/70 hover:text-cyan-200 hover:bg-cyan-500/10 transition text-left"
      >
        <Search className="h-3 w-3 text-cyan-400/70 shrink-0" />
        <span className="font-medium">
          {ev.name}
          {query ? `: "${query}"` : ''}
        </span>
        {pending && <span className="text-cyan-400/70 animate-pulse font-normal">running…</span>}
        <span className="ml-auto opacity-50 flex items-center gap-1 text-[10px]">
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          {expanded ? 'hide' : 'show'}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 max-h-56 overflow-y-auto border-t border-cyan-500/15 pt-2">
          {ev.error && <div className="text-[11px] text-red-300/80">{ev.error}</div>}
          {!ev.error && searchResults.length === 0 && !pending && (
            <div className="text-[11px] text-cyan-100/50">No results.</div>
          )}
          {!ev.error && ev.name === 'get_current_date' && ev.result != null && (
            <div className="text-[11px] text-cyan-100/70 font-mono">
              {JSON.stringify(ev.result)}
            </div>
          )}
          {searchResults.length > 0 && (
            <ul className="space-y-2">
              {searchResults.map((r, idx) => (
                <li key={idx} className="text-[11px]">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-cyan-300 hover:underline font-medium"
                  >
                    {r.title || r.url}
                  </a>
                  {r.snippet && <div className="text-cyan-100/50 mt-0.5">{r.snippet}</div>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

interface MessageBubbleProps {
  m: ChatMessage;
  isStreaming: boolean;
  // Whether ANY message in this column is currently streaming — not just
  // this one. Regenerate/delete are withheld column-wide while a generation
  // is in flight, matching the original single-loop implementation's
  // `!streamingId` guard.
  columnBusy: boolean;
  isLastMessage: boolean;
  coldStart: boolean;
  coldElapsed: number;
  queuedAhead?: number | null;
  expandedIds: Set<string>;
  onToggle: (id: string) => void;
  onRegenerate?: () => void;
  onDeletePair?: (assistantMessageId: string) => void;
  onEditMessage?: (userMessageId: string, newText: string) => void;
}

// One message row. Memoized so that, while a reply streams in, only the
// bubble whose own `m` object actually changed re-renders — every other
// message in a long conversation keeps its previous render output instead of
// re-executing trace mapping / markdown parsing on every token (see the
// perf investigation this was extracted for: chat-panel.tsx and
// use-column-chat.ts feed this the same `m` reference for untouched
// messages, so the shallow prop comparison below correctly bails for them).
const MessageBubble = memo(function MessageBubble({
  m,
  isStreaming,
  columnBusy,
  isLastMessage,
  coldStart,
  coldElapsed,
  queuedAhead,
  expandedIds,
  onToggle,
  onRegenerate,
  onDeletePair,
  onEditMessage,
}: MessageBubbleProps) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  // Decouples markdown re-parsing from the raw per-token update rate: React
  // can coalesce several rapid `m.content` changes into a single deferred
  // update instead of re-parsing the full accumulated string on every token
  // (the cost that scales hardest with reply length).
  const deferredContent = useDeferredValue(m.content);

  function startEdit() {
    setEditText(m.content);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
    setEditText('');
  }
  function saveEdit() {
    const text = editText.trim();
    setEditing(false);
    if (text) onEditMessage?.(m.id, text);
  }

  const isUser = m.role === 'user';
  const trace = m.trace ?? [];
  const lastTrace = trace[trace.length - 1];
  const traceActive = isStreaming && !m.content && !!lastTrace;

  if (m.role === 'system') {
    const expanded = expandedIds.has(m.id);
    return (
      <div className="rounded-lg border border-[rgb(var(--accent-glow)/0.25)] bg-[rgb(var(--accent-glow)/0.06)] overflow-hidden">
        <button
          type="button"
          onClick={() => onToggle(m.id)}
          className="w-full flex items-center gap-2 px-3 py-2 text-[11px] text-white/60 hover:text-white/90 hover:bg-[rgb(var(--accent-glow)/0.08)] transition text-left"
        >
          <FoldVertical className="h-3 w-3 text-[rgb(var(--accent-glow)/0.8)] shrink-0" />
          <span className="font-medium">Compacted context</span>
          <span className="opacity-50">summary of earlier conversation</span>
          <span className="ml-auto opacity-50 flex items-center gap-1 text-[10px]">
            {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {expanded ? 'hide' : 'show'}
          </span>
        </button>
        {expanded && (
          <div className="px-3 pb-3 pt-2 border-t border-[rgb(var(--accent-glow)/0.15)] max-h-56 overflow-y-auto">
            <div className="text-[11px] text-white/55 whitespace-pre-wrap leading-relaxed">
              {m.content}
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className={`group rounded-xl px-3.5 py-2.5 leading-relaxed text-sm border ${
        isUser
          ? 'bg-[rgb(var(--accent-glow)/0.13)] border-[rgb(var(--accent-glow)/0.28)] shadow-[inset_0_1px_0_rgba(255,255,255,0.04)] dark-green-chat-user'
          : 'bg-white/[0.04] border-white/[0.08]'
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide mb-1.5 text-white/40 flex items-center gap-2">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            isUser ? 'bg-[rgb(var(--accent-glow))]' : 'bg-white/30'
          }`}
        />
        {m.role}
        {isStreaming && !m.content && coldStart && (
          <span className="text-indigo-300/80 flex items-center gap-1 normal-case">
            <span className="animate-pulse">●</span> Loading model… {coldElapsed}s
          </span>
        )}
        {isStreaming && !m.content && !coldStart && !!queuedAhead && (
          <span className="text-amber-300/70 flex items-center gap-1 normal-case">
            <span className="animate-pulse">●</span> Waiting on Ollama ({queuedAhead} other request
            {queuedAhead === 1 ? '' : 's'})…
          </span>
        )}
        {isStreaming && !m.content && !coldStart && !queuedAhead && (
          <span className="text-amber-400/70 flex items-center gap-1 normal-case">
            <span className="animate-pulse">●</span> {traceActive ? 'Working…' : 'Thinking…'}
          </span>
        )}
        {isStreaming && !!m.content && (
          <span className="text-emerald-400/70 flex items-center gap-1 normal-case">
            <span className="animate-pulse">●</span> Responding…
          </span>
        )}
      </div>
      {isUser ? (
        editing ? (
          <div className="flex flex-col gap-2">
            <textarea
              autoFocus
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  saveEdit();
                }
                if (e.key === 'Escape') cancelEdit();
              }}
              className="min-h-[60px] rounded-lg border border-white/15 bg-black/30 px-2.5 py-2 text-sm text-white focus:outline-none focus:border-[rgb(var(--accent-glow)/0.5)]"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveEdit}
                className="inline-flex items-center gap-1 rounded-md bg-[rgb(var(--accent-glow)/0.2)] px-2 py-1 text-[11px] text-white hover:bg-[rgb(var(--accent-glow)/0.3)] transition"
              >
                <Check className="h-3 w-3" /> Save & resend
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-white/50 hover:text-white/80 hover:bg-white/10 transition"
              >
                <X className="h-3 w-3" /> Cancel
              </button>
              <span className="text-[10px] text-white/30">
                Everything after this message will be removed and regenerated.
              </span>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {!!m.images?.length && (
              <div className="flex flex-wrap gap-2">
                {m.images.map((img, idx) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={idx}
                    src={`data:image/png;base64,${img}`}
                    alt=""
                    className="max-h-40 rounded-lg border border-white/15 object-contain"
                  />
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap text-white/90 font-light dark-green-chat-user-text">
              {m.content}
            </div>
          </div>
        )
      ) : (
        <div className="space-y-2">
          {trace.map((ev, idx) => {
            const isLast = idx === trace.length - 1;
            const active = traceActive && isLast;
            const expanded = expandedIds.has(ev.id) || active;
            return ev.type === 'thinking' ? (
              <ThinkingLine
                key={ev.id}
                ev={ev}
                expanded={expanded}
                active={active}
                onToggle={() => onToggle(ev.id)}
              />
            ) : (
              <ToolLine key={ev.id} ev={ev} expanded={expanded} onToggle={() => onToggle(ev.id)} />
            );
          })}
          {!m.content && isStreaming && coldStart ? (
            // Distinct from the "thinking" llamas below — the model
            // hasn't started reasoning yet, it's still being loaded
            // into memory. Conflating the two was misleading: minutes
            // of "Thinking…" for a model that hadn't even started.
            <div className="flex items-center gap-2 h-6 text-xs text-indigo-300/70">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400/60"></span>
                <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400"></span>
              </span>
              Loading model into memory… {coldElapsed}s
            </div>
          ) : !m.content && isStreaming ? (
            <div className="flex items-center gap-1 h-6">
              <span className="animate-bounce [animation-delay:-0.25s]">🦙</span>
              <span className="animate-bounce [animation-delay:-0.15s]">🦙</span>
              <span className="animate-bounce [animation-delay:-0.05s]">🦙</span>
            </div>
          ) : m.content && looksLikePseudoToolCall(m.content) && isStreaming ? (
            <PseudoToolCallIndicator />
          ) : m.content ? (
            <div className="prose prose-invert max-w-none text-white/90 prose-p:my-2 prose-ul:my-2 prose-li:my-1 prose-pre:my-3 prose-code:px-1 prose-code:py-0.5 prose-code:bg-white/10 prose-code:rounded">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{ pre: CodeBlockPre }}
              >
                {(() => {
                  const parsed = parsePseudoToolCall(deferredContent);
                  return parsed ? renderPseudoToolCallAsMarkdown(parsed) : deferredContent;
                })()}
              </ReactMarkdown>
            </div>
          ) : (
            // Generation finished but produced no real answer — most often the
            // model spent its whole context window "thinking" (see the trace
            // above) and never got to write a reply. Say so instead of looking
            // like it's still loading forever.
            <div className="flex items-start gap-1.5 text-amber-200/70 text-xs">
              <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              <span>
                No answer was produced
                {trace.length > 0
                  ? ' — the model likely ran out of context while reasoning (see above). Try increasing the context window or regenerate.'
                  : '.'}
              </span>
            </div>
          )}
          {!isStreaming && m.stats && (m.stats.completionTokens || m.stats.tokensPerSecond) && (
            <div className="text-[10px] font-mono text-white/25 pt-0.5">
              {m.stats.completionTokens != null && `${m.stats.completionTokens} tok`}
              {m.stats.completionTokens != null && m.stats.tokensPerSecond != null && ' · '}
              {m.stats.tokensPerSecond != null && `${m.stats.tokensPerSecond} tok/s`}
            </div>
          )}
        </div>
      )}
      {!isStreaming && !editing && (
        <div className="mt-1.5 hidden group-hover:flex items-center gap-1">
          {onEditMessage && isUser && (
            <button
              type="button"
              title="Edit & resend"
              onClick={startEdit}
              className="p-1 rounded text-white/30 hover:text-white/80 hover:bg-white/10 transition"
            >
              <Pencil className="h-3 w-3" />
            </button>
          )}
          <button
            type="button"
            title="Copy message"
            onClick={async () => {
              try {
                const parsed = parsePseudoToolCall(m.content);
                const toCopy = parsed ? renderPseudoToolCallAsMarkdown(parsed) : m.content;
                await navigator.clipboard.writeText(toCopy);
                useToastStore.getState().push({ type: 'success', message: 'Copied to clipboard' });
              } catch {
                useToastStore
                  .getState()
                  .push({ type: 'error', message: 'Could not copy to clipboard' });
              }
            }}
            className="p-1 rounded text-white/30 hover:text-white/80 hover:bg-white/10 transition"
          >
            <Copy className="h-3 w-3" />
          </button>
          {onRegenerate && m.role === 'assistant' && isLastMessage && !columnBusy && (
            <button
              type="button"
              title="Regenerate response"
              onClick={onRegenerate}
              className="p-1 rounded text-white/30 hover:text-white/80 hover:bg-white/10 transition"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
          {onDeletePair && m.role === 'assistant' && !columnBusy && (
            <button
              type="button"
              title="Delete this exchange"
              onClick={() => onDeletePair(m.id)}
              className="p-1 rounded text-white/30 hover:text-red-300 hover:bg-white/10 transition"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export function ChatColumn({
  messages,
  streamingId,
  coldStart,
  coldElapsed,
  queuedAhead,
  emptyLabel,
  onRegenerate,
  onDeletePair,
  onEditMessage,
}: ChatColumnProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Whether the view was already pinned to the bottom before this update —
  // starts true so a freshly loaded session still lands scrolled to its
  // latest message. Updated by the scroll handler below, independently of
  // the auto-scroll effect itself, so the effect never has to guess based on
  // a layout it just wrote.
  const stickToBottomRef = useRef(true);

  const toggle = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // Auto-scroll to the latest message, but only while the user was already
  // near the bottom — and batched via rAF so several token updates within
  // the same frame collapse into a single scrollTop write instead of one
  // forced reflow per token.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !stickToBottomRef.current) return;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages]);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="flex-1 min-h-0 overflow-auto rounded-xl border border-white/[0.06] bg-black/25 p-3 text-sm space-y-3"
    >
      {coldStart && (
        <div className="flex items-center gap-2 text-[11px] text-white/60 dark-green-model-loaded-indicator">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400/60 dark-green-pill-ping"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-indigo-400 dark-green-pill"></span>
          </span>
          <span>Loading model… {coldElapsed}s</span>
        </div>
      )}
      {!coldStart && !!queuedAhead && (
        <div
          className="flex items-center gap-2 text-[11px] text-amber-300/70"
          title="Another request to this same model was already running when this one started. Whether it actually runs alongside it depends on the Ollama server (OLLAMA_NUM_PARALLEL and available VRAM) — this app can't control that."
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400/60"></span>
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-400"></span>
          </span>
          <span>
            Waiting on Ollama — {queuedAhead} other request{queuedAhead === 1 ? '' : 's'} already
            running for this model
          </span>
        </div>
      )}
      {messages.length === 0 && (
        <div className="text-white/40 text-xs">{emptyLabel ?? 'No messages yet.'}</div>
      )}
      {messages.map((m, idx) => (
        <MessageBubble
          key={m.id}
          m={m}
          isStreaming={m.id === streamingId}
          columnBusy={!!streamingId}
          isLastMessage={idx === messages.length - 1}
          coldStart={coldStart}
          coldElapsed={coldElapsed}
          queuedAhead={queuedAhead}
          expandedIds={expandedIds}
          onToggle={toggle}
          onRegenerate={onRegenerate}
          onDeletePair={onDeletePair}
          onEditMessage={onEditMessage}
        />
      ))}
    </div>
  );
}
