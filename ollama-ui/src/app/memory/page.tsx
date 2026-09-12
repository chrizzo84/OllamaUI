'use client';
/**
 * What the assistant believes about you — and where it isn't sure.
 *
 * The memory writes itself, which is exactly why it needs a surface like
 * this: nobody typed these facts, so "what is in there, where did it come
 * from, and what disagrees with what" is not a nice-to-have but the only way
 * to tell a knowledge base from an accumulation of confident guesses.
 *
 * The contradiction inbox sits at the top on purpose. A disagreement nobody
 * resolves doesn't stay open — it gets settled at random inside the prompt,
 * differently every time, and that is invisible from the chat.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/store/toast';
import { Pin, PinOff, Archive, Trash2, Plus, History, GitBranch, Check } from 'lucide-react';

type MemoryType = 'identity' | 'state' | 'preference' | 'episodic' | 'procedural' | 'unsorted';
type MemoryStatus = 'active' | 'superseded' | 'archived' | 'draft';

interface MemoryItem {
  id: string;
  content: string;
  type: MemoryType;
  subject: string | null;
  status: MemoryStatus;
  confidence: number;
  pinned: boolean;
  useCount: number;
  lastUsedAt: number | null;
  sourceSessionId: string | null;
  createdAt: number;
}

interface ContradictionSide {
  id: string;
  content: string;
  createdAt: number;
  sourceSessionId: string | null;
  sourceSessionTitle: string | null;
}

interface Contradiction {
  edgeId: string;
  detectedAt: number;
  subject: string | null;
  newer: ContradictionSide | null;
  older: ContradictionSide | null;
}

const TYPE_LABELS: Record<MemoryType, string> = {
  identity: 'About you',
  preference: 'How you want me to work',
  state: 'Current situation',
  episodic: 'Things that happened',
  procedural: 'Procedures',
  unsorted: 'Not yet sorted',
};

const TYPE_ORDER: MemoryType[] = [
  'identity',
  'preference',
  'state',
  'episodic',
  'procedural',
  'unsorted',
];

const TYPE_HINTS: Record<MemoryType, string> = {
  identity: 'Durable traits. Always sent to the model, regardless of the topic.',
  preference: 'How you want answers written. Always sent.',
  state: 'True right now, and expected to change.',
  episodic: 'Tied to a point in time. Never displaces anything.',
  procedural: 'How to do something in this setup.',
  unsorted: 'Saved before facts had types, or the model was unsure. Sorting these helps retrieval.',
};

function formatWhen(ms: number): string {
  const diff = Date.now() - ms;
  const day = Math.floor(diff / 86_400_000);
  if (day > 30) return new Date(ms).toLocaleDateString();
  if (day >= 1) return `vor ${day} ${day === 1 ? 'Tag' : 'Tagen'}`;
  const hour = Math.floor(diff / 3_600_000);
  if (hour >= 1) return `vor ${hour} h`;
  const min = Math.floor(diff / 60_000);
  return min >= 1 ? `vor ${min} min` : 'gerade eben';
}

/** `[[Ollama Host]]` rendered as a highlighted node reference. */
function LinkedContent({ text }: { text: string }) {
  const parts = text.split(/(\[\[[^\]]+\]\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const match = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(part);
        if (!match) return <span key={i}>{part}</span>;
        return (
          <span
            key={i}
            className="rounded bg-[rgb(var(--accent-glow)/0.14)] px-1 text-[rgb(var(--accent-glow))]"
            title="Entity in the knowledge graph"
          >
            {(match[2] ?? match[1]).trim()}
          </span>
        );
      })}
    </>
  );
}

export default function MemoryPage() {
  const pushToast = useToastStore((s) => s.push);
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [drafts, setDrafts] = useState<MemoryItem[]>([]);
  const [contradictions, setContradictions] = useState<Contradiction[]>([]);
  const [loading, setLoading] = useState(true);
  const [newFact, setNewFact] = useState('');
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<{ subject: string; items: MemoryItem[] } | null>(null);

  const load = useCallback(async () => {
    try {
      const [activeRes, draftRes, conRes] = await Promise.all([
        fetch('/api/memories', { cache: 'no-store' }),
        fetch('/api/memories?status=draft', { cache: 'no-store' }),
        fetch('/api/memories/contradictions', { cache: 'no-store' }),
      ]);
      if (activeRes.ok) setItems((await activeRes.json()).items ?? []);
      if (draftRes.ok) setDrafts((await draftRes.json()).items ?? []);
      if (conRes.ok) setContradictions((await conRes.json()).items ?? []);
    } catch {
      /* the empty states below say enough */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const mark = (id: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  async function act(id: string, action: string, extra: Record<string, unknown> = {}) {
    mark(id, true);
    try {
      const r = await fetch('/api/memories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action, ...extra }),
      });
      if (!r.ok) throw new Error('Request failed');
      await load();
    } catch {
      pushToast({ type: 'error', message: 'Konnte nicht gespeichert werden.' });
    } finally {
      mark(id, false);
    }
  }

  async function resolve(edgeId: string, keep: 'newer' | 'older' | 'both') {
    mark(edgeId, true);
    try {
      const r = await fetch('/api/memories/contradictions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edgeId, keep }),
      });
      if (!r.ok) throw new Error('Request failed');
      await load();
      pushToast({ type: 'success', message: 'Widerspruch aufgelöst.' });
    } catch {
      pushToast({ type: 'error', message: 'Konnte nicht aufgelöst werden.' });
    } finally {
      mark(edgeId, false);
    }
  }

  async function handleAdd() {
    const content = newFact.trim();
    if (!content || adding) return;
    setAdding(true);
    try {
      const r = await fetch('/api/memories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) throw new Error('Request failed');
      const saved = await r.json();
      setNewFact('');
      await load();
      // Silence here would be wrong: both outcomes are things the person
      // would otherwise discover only by noticing their fact isn't listed.
      if (saved.alreadyKnown) {
        pushToast({ type: 'info', message: 'Das war schon gespeichert.' });
      } else if (saved.replaced) {
        pushToast({ type: 'success', message: `Ersetzt: „${saved.replaced.content}"` });
      }
    } catch {
      pushToast({ type: 'error', message: 'Konnte nicht gespeichert werden.' });
    } finally {
      setAdding(false);
    }
  }

  async function openHistory(subject: string) {
    const r = await fetch(`/api/memories?subject=${encodeURIComponent(subject)}`, {
      cache: 'no-store',
    });
    if (!r.ok) return;
    setHistory({ subject, items: (await r.json()).items ?? [] });
  }

  const grouped = useMemo(() => {
    const map = new Map<MemoryType, MemoryItem[]>();
    for (const item of items) {
      const list = map.get(item.type) ?? [];
      list.push(item);
      map.set(item.type, list);
    }
    return TYPE_ORDER.map((type) => [type, map.get(type) ?? []] as const).filter(
      ([, list]) => list.length > 0,
    );
  }, [items]);

  const alwaysSent = items.filter((i) => i.type === 'identity' || i.pinned).length;

  return (
    <div className="relative mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-10 py-14">
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
          Knowledge base
        </span>
        <div className="flex flex-wrap items-center gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-gradient-hero">Memory</h1>
          <span className="text-[10px] font-mono text-white/25">
            what the assistant believes about you, and where it came from
          </span>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div className="glass-card flex flex-col gap-1 p-4">
          <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
            Active facts
          </span>
          <span className="text-2xl font-bold tabular-nums text-white/90">{items.length}</span>
          <span
            className="text-[10px] text-white/30"
            title="Identity and pinned facts go into every prompt; the rest are picked by relevance to the conversation."
          >
            {alwaysSent} always sent
          </span>
        </div>
        <div className="glass-card flex flex-col gap-1 p-4">
          <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
            Awaiting review
          </span>
          <span className="text-2xl font-bold tabular-nums text-white/90">{drafts.length}</span>
          <span className="text-[10px] text-white/30">not used until approved</span>
        </div>
        <div
          className={`glass-card flex flex-col gap-1 p-4 ${contradictions.length ? 'border-amber-400/30' : ''}`}
        >
          <span className="text-[10px] font-mono uppercase tracking-wider text-white/30">
            Contradictions
          </span>
          <span
            className={`text-2xl font-bold tabular-nums ${contradictions.length ? 'text-amber-300' : 'text-white/90'}`}
          >
            {contradictions.length}
          </span>
          <span className="text-[10px] text-white/30">
            {contradictions.length ? 'decided at random until resolved' : 'nothing in dispute'}
          </span>
        </div>
      </div>

      {/* --- Contradiction inbox ------------------------------------------- */}
      {contradictions.length > 0 && (
        <motion.section
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          className="flex flex-col gap-3"
        >
          <div className="flex items-baseline gap-2">
            <GitBranch className="h-3.5 w-3.5 text-amber-300/70" />
            <h2 className="text-sm font-semibold text-white/80">Needs a decision</h2>
            <span className="text-[10px] text-white/30">
              two facts about the same thing that say different things
            </span>
          </div>
          {contradictions.map((c) => (
            <div
              key={c.edgeId}
              className="rounded-xl border border-amber-400/25 bg-amber-400/[0.04] p-4"
            >
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[10px] font-mono text-white/35">
                {c.subject && (
                  <span className="cap-pill border-white/15 bg-white/5">{c.subject}</span>
                )}
                <span>noticed {formatWhen(c.detectedAt)}</span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {(
                  [
                    ['newer', c.newer, 'Newer — currently in use'],
                    ['older', c.older, 'Older — replaced'],
                  ] as const
                ).map(([which, side, heading]) => (
                  <div
                    key={which}
                    className={`rounded-lg border p-3 ${
                      which === 'newer'
                        ? 'border-[rgb(var(--accent-glow)/0.35)] bg-[rgb(var(--accent-glow)/0.06)]'
                        : 'border-white/10 bg-white/[0.03]'
                    }`}
                  >
                    <div className="mb-1.5 text-[10px] font-mono uppercase tracking-wider text-white/30">
                      {heading}
                    </div>
                    <p className="text-sm leading-relaxed text-white/85">
                      {side ? <LinkedContent text={side.content} /> : <em>gelöscht</em>}
                    </p>
                    {side && (
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-white/30">
                        <span>{formatWhen(side.createdAt)}</span>
                        {side.sourceSessionId && (
                          <Link
                            href={`/chat?session=${side.sourceSessionId}`}
                            className="underline decoration-dotted hover:text-white/60"
                            title="Open the conversation this came from"
                          >
                            aus „{side.sourceSessionTitle || 'Chat'}&ldquo;
                          </Link>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={() => resolve(c.edgeId, 'newer')}
                  disabled={busy.has(c.edgeId)}
                >
                  Neue gilt
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => resolve(c.edgeId, 'older')}
                  disabled={busy.has(c.edgeId)}
                  title="Die Ersetzung war falsch — die beiden tauschen die Rollen, nichts geht verloren."
                >
                  Alte gilt
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => resolve(c.edgeId, 'both')}
                  disabled={busy.has(c.edgeId)}
                  title="Waren nie dieselbe Frage — beide bleiben, die ältere nimmt nicht mehr an der Verdrängung teil."
                >
                  Beide behalten
                </Button>
              </div>
            </div>
          ))}
        </motion.section>
      )}

      {/* --- Drafts --------------------------------------------------------- */}
      {drafts.length > 0 && (
        <section className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2">
            <h2 className="text-sm font-semibold text-white/80">Saved for review</h2>
            <span className="text-[10px] text-white/30">
              the model wasn&apos;t sure — not used until you approve
            </span>
          </div>
          {drafts.map((d) => (
            <div
              key={d.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4"
            >
              <p className="min-w-0 flex-1 text-sm text-white/80">
                <LinkedContent text={d.content} />
                <span className="ml-2 text-[10px] font-mono text-white/30">
                  confidence {Math.round(d.confidence * 100)}%
                </span>
              </p>
              <div className="flex shrink-0 gap-2">
                <Button size="sm" onClick={() => act(d.id, 'approve')} disabled={busy.has(d.id)}>
                  <Check className="h-3.5 w-3.5" /> Übernehmen
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => act(d.id, 'archive')}
                  disabled={busy.has(d.id)}
                >
                  Verwerfen
                </Button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* --- Add ------------------------------------------------------------ */}
      <div className="flex gap-2">
        <input
          value={newFact}
          onChange={(e) => setNewFact(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleAdd();
          }}
          placeholder="Fakt hinzufügen — [[doppelte Klammern]] verlinken Dinge im Graphen"
          className="flex-1 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-sm text-white/85 placeholder:text-white/25 focus:border-[rgb(var(--accent-glow)/0.5)] focus:outline-none"
        />
        <Button onClick={handleAdd} loading={adding} disabled={!newFact.trim()}>
          <Plus className="h-4 w-4" /> Merken
        </Button>
      </div>

      {/* --- The facts ------------------------------------------------------ */}
      {loading ? (
        <div className="animate-pulse text-white/50">Lade…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-white/50">
          Noch nichts gemerkt. Fakten entstehen im Chat, sobald etwas Dauerhaftes gesagt wird — oder
          oben von Hand.
        </div>
      ) : (
        grouped.map(([type, list]) => (
          <section key={type} className="flex flex-col gap-2">
            <div className="flex items-baseline gap-2">
              <h2 className="text-sm font-semibold text-white/80">{TYPE_LABELS[type]}</h2>
              <span className="text-[10px] text-white/30">{TYPE_HINTS[type]}</span>
            </div>
            <ul className="flex flex-col gap-2">
              {list.map((m) => (
                <li
                  key={m.id}
                  className="group flex flex-wrap items-start justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-4 transition hover:border-white/20"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-relaxed text-white/85">
                      <LinkedContent text={m.content} />
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] text-white/30">
                      {m.pinned && (
                        <span className="text-[rgb(var(--accent-glow))]">angepinnt</span>
                      )}
                      <span>{formatWhen(m.createdAt)}</span>
                      <span title="How often retrieval actually picked this fact — what earns its place in the context window.">
                        {m.useCount}× benutzt
                      </span>
                      {m.subject && (
                        <button
                          onClick={() => openHistory(m.subject!)}
                          className="inline-flex items-center gap-1 underline decoration-dotted hover:text-white/60"
                          title="Was hierzu früher galt"
                        >
                          <History className="h-3 w-3" />
                          {m.subject}
                        </button>
                      )}
                      {m.sourceSessionId && (
                        <Link
                          href={`/chat?session=${m.sourceSessionId}`}
                          className="underline decoration-dotted hover:text-white/60"
                        >
                          Quelle
                        </Link>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1 opacity-60 transition group-hover:opacity-100">
                    <select
                      value={m.type}
                      onChange={(e) => act(m.id, 'classify', { type: e.target.value })}
                      disabled={busy.has(m.id)}
                      className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-1 text-[10px] text-white/60 focus:outline-none"
                      title="Art des Fakts — bestimmt, ob er immer mitgeschickt wird und ob er verdrängen kann"
                    >
                      {TYPE_ORDER.map((t) => (
                        <option key={t} value={t} className="bg-neutral-900">
                          {t}
                        </option>
                      ))}
                    </select>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => act(m.id, m.pinned ? 'unpin' : 'pin')}
                      disabled={busy.has(m.id)}
                      title={m.pinned ? 'Nicht mehr immer mitschicken' : 'Immer mitschicken'}
                    >
                      {m.pinned ? (
                        <PinOff className="h-3.5 w-3.5" />
                      ) : (
                        <Pin className="h-3.5 w-3.5" />
                      )}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => act(m.id, 'archive')}
                      disabled={busy.has(m.id)}
                      title="Archivieren — bleibt als Historie erhalten"
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={async () => {
                        mark(m.id, true);
                        await fetch(`/api/memories?id=${encodeURIComponent(m.id)}`, {
                          method: 'DELETE',
                        }).catch(() => {});
                        await load();
                        mark(m.id, false);
                      }}
                      disabled={busy.has(m.id)}
                      title="Endgültig löschen — im Zweifel lieber archivieren"
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-400/70" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {/* --- History ------------------------------------------------------- */}
      {history && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setHistory(null)}
        >
          <div
            className="max-h-[70vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-white/10 bg-neutral-950 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-baseline justify-between gap-3">
              <h3 className="font-semibold text-white/90">
                Historie: <span className="font-mono text-white/60">{history.subject}</span>
              </h3>
              <Button size="sm" variant="ghost" onClick={() => setHistory(null)}>
                Schließen
              </Button>
            </div>
            <ol className="flex flex-col gap-3">
              {history.items.map((h) => (
                <li
                  key={h.id}
                  className={`rounded-lg border p-3 ${
                    h.status === 'active'
                      ? 'border-[rgb(var(--accent-glow)/0.35)] bg-[rgb(var(--accent-glow)/0.06)]'
                      : 'border-white/10 bg-white/[0.02] opacity-70'
                  }`}
                >
                  <p className="text-sm text-white/85">
                    <LinkedContent text={h.content} />
                  </p>
                  <div className="mt-1 flex gap-2 text-[10px] font-mono text-white/30">
                    <span>{h.status}</span>
                    <span>{formatWhen(h.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
