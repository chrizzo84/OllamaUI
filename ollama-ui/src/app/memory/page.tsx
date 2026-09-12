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
import { MemoryGraph, type GraphNode, type GraphEdge } from '@/components/memory-graph';

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

interface EntitySummary {
  id: string;
  label: string;
  memoryCount: number;
}

type Tab = 'facts' | 'graph' | 'timeline';

type TimelineKind = 'learned' | 'replaced' | 'archived' | 'drafted';

interface TimelineEvent {
  at: number;
  kind: TimelineKind;
  memoryId: string;
  content: string;
  type: MemoryType;
  subject: string | null;
  sourceSessionId: string | null;
  sourceSessionTitle: string | null;
  replacedBy?: { id: string; content: string };
}

const EVENT_LABEL: Record<TimelineKind, string> = {
  learned: 'gelernt',
  drafted: 'zur Prüfung gemerkt',
  replaced: 'ersetzt',
  archived: 'archiviert',
};

const EVENT_COLOUR: Record<TimelineKind, string> = {
  learned: 'bg-emerald-400/70',
  drafted: 'bg-white/30',
  replaced: 'bg-amber-400/70',
  archived: 'bg-white/20',
};

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
  const [tab, setTab] = useState<Tab>('facts');
  const [graph, setGraph] = useState<{ nodes: GraphNode[]; edges: GraphEdge[]; truncated: number }>(
    { nodes: [], edges: [], truncated: 0 },
  );
  const [entities, setEntities] = useState<EntitySummary[]>([]);
  const [focus, setFocus] = useState<string | undefined>();
  const [selected, setSelected] = useState<GraphNode | null>(null);
  const [selectedFacts, setSelectedFacts] = useState<MemoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);

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

  // The graph is only fetched while its tab is open: it is the one query here
  // that walks the whole edge table, and nobody looking at the fact list
  // needs it.
  useEffect(() => {
    if (tab !== 'graph') return;
    const params = new URLSearchParams();
    if (focus) params.set('focus', focus);
    if (showHistory) params.set('history', '1');
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/memories/graph?${params}`, { cache: 'no-store' });
        if (!r.ok || cancelled) return;
        const j = await r.json();
        setGraph({ nodes: j.nodes ?? [], edges: j.edges ?? [], truncated: j.truncated ?? 0 });
        setEntities(j.entities ?? []);
      } catch {
        /* the empty state in the canvas says enough */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, focus, showHistory]);

  useEffect(() => {
    if (tab !== 'timeline') return;
    let cancelled = false;
    (async () => {
      const r = await fetch('/api/memories/timeline', { cache: 'no-store' });
      if (r.ok && !cancelled) setTimeline((await r.json()).items ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  // What is known about the selected node — the backlink view for an entity,
  // the fact itself for a fact. This is the part that makes the graph useful
  // rather than pretty: a dot you can't read is just a dot.
  useEffect(() => {
    if (!selected) {
      setSelectedFacts([]);
      return;
    }
    let cancelled = false;
    (async () => {
      if (selected.kind === 'entity') {
        const id = selected.id.slice('entity:'.length);
        // Follows the canvas: with history drawn, the panel shows it too, so
        // the two halves of the view never disagree about what is current.
        const r = await fetch(
          `/api/memories?entity=${encodeURIComponent(id)}${showHistory ? '&history=1' : ''}`,
          { cache: 'no-store' },
        );
        if (r.ok && !cancelled) setSelectedFacts((await r.json()).items ?? []);
      } else {
        const id = selected.id.slice('memory:'.length);
        const r = await fetch(`/api/memories?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
        if (r.ok && !cancelled) setSelectedFacts((await r.json()).items ?? []);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected, showHistory]);

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

      <div className="flex items-center gap-1 border-b border-white/10">
        {(
          [
            ['facts', 'Fakten'],
            ['graph', 'Graph'],
            ['timeline', 'Verlauf'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition ${
              tab === key
                ? 'border-[rgb(var(--accent-glow))] text-white/90'
                : 'border-transparent text-white/45 hover:text-white/70'
            }`}
          >
            {label}
          </button>
        ))}
        {tab === 'graph' && (
          <label className="ml-auto flex cursor-pointer select-none items-center gap-2 pb-2 text-[11px] text-white/45">
            <input
              type="checkbox"
              className="accent-violet-500"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />
            Historie mitzeichnen
          </label>
        )}
      </div>

      {/* The inbox is the work queue, so it stays in reach from either tab —
          but in the graph view it collapses to one line rather than pushing
          the canvas below the fold, where a graph nobody scrolls to is a
          graph nobody looks at. */}
      {tab === 'graph' && contradictions.length > 0 && (
        <button
          onClick={() => setTab('facts')}
          className="flex items-center gap-2 self-start rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-1.5 text-xs text-amber-200/90 hover:bg-amber-400/[0.12]"
        >
          <GitBranch className="h-3.5 w-3.5" />
          {contradictions.length} {contradictions.length === 1 ? 'Widerspruch' : 'Widersprüche'}{' '}
          offen — entscheiden
        </button>
      )}

      {/* --- Contradiction inbox ------------------------------------------- */}
      {tab === 'facts' && contradictions.length > 0 && (
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
      {tab === 'facts' && drafts.length > 0 && (
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
      {tab === 'facts' && (
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
      )}

      {/* --- Graph ---------------------------------------------------------- */}
      {tab === 'graph' && (
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="min-w-0 flex-1">
            <MemoryGraph
              nodes={graph.nodes}
              edges={graph.edges}
              focus={focus}
              onFocus={setFocus}
              onSelect={setSelected}
            />
            {graph.truncated > 0 && !focus && (
              <p className="mt-2 text-[11px] text-white/35">
                {graph.truncated} weitere Knoten nicht gezeichnet — die Übersicht zeigt die am
                stärksten verknüpften und am häufigsten benutzten. Ein Klick auf einen Knoten
                zentriert auf dessen Nachbarschaft.
              </p>
            )}
          </div>

          <aside className="flex w-full shrink-0 flex-col gap-3 lg:w-80">
            {selected ? (
              <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
                <div className="mb-2 text-[10px] font-mono uppercase tracking-wider text-white/30">
                  {selected.kind === 'entity' ? 'Entität' : 'Fakt'}
                </div>
                <h3 className="text-sm font-semibold text-white/90">{selected.label}</h3>
                {selected.kind === 'entity' && (
                  <p className="mt-1 text-[11px] text-white/40">
                    {selectedFacts.length} {selectedFacts.length === 1 ? 'Fakt' : 'Fakten'} handeln
                    davon
                  </p>
                )}
                <ul className="mt-3 flex flex-col gap-2">
                  {selectedFacts.map((f) => (
                    <li
                      key={f.id}
                      className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5"
                    >
                      <p className="text-xs leading-relaxed text-white/80">
                        <LinkedContent text={f.content} />
                      </p>
                      <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-white/30">
                        <span>{f.type}</span>
                        <span>{formatWhen(f.createdAt)}</span>
                        <span>{f.useCount}× benutzt</span>
                        {f.sourceSessionId && (
                          <Link
                            href={`/chat?session=${f.sourceSessionId}`}
                            className="underline decoration-dotted hover:text-white/60"
                          >
                            Quelle
                          </Link>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 text-[11px] leading-relaxed text-white/40">
                Ein Knoten zeigt hier, was dahintersteckt — bei einer Entität alles, was über sie
                bekannt ist. Klicken zentriert den Graphen auf die Nachbarschaft.
              </div>
            )}

            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="mb-2 text-[10px] font-mono uppercase tracking-wider text-white/30">
                Entitäten
              </div>
              {entities.length === 0 ? (
                <p className="text-[11px] text-white/35">
                  Noch keine — [[Klammern]] in einem Fakt legen sie an.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {entities.slice(0, 40).map((e) => (
                    <li key={e.id}>
                      <button
                        onClick={() => {
                          setFocus(`entity:${e.id}`);
                          setSelected({ id: `entity:${e.id}`, kind: 'entity', label: e.label });
                        }}
                        className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition hover:bg-white/[0.06] ${
                          focus === `entity:${e.id}`
                            ? 'bg-white/[0.08] text-white/90'
                            : 'text-white/60'
                        }`}
                      >
                        <span className="truncate">{e.label}</span>
                        <span className="shrink-0 font-mono text-[10px] text-white/30">
                          {e.memoryCount}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* --- Timeline ------------------------------------------------------- */}
      {tab === 'timeline' && (
        <section className="flex flex-col gap-1">
          <p className="mb-2 text-[11px] text-white/35">
            Wann das Gedächtnis was gelernt und was es wieder verworfen hat — meist die Antwort
            darauf, warum es etwas glaubt.
          </p>
          {timeline.length === 0 ? (
            <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-white/50">
              Noch nichts passiert.
            </div>
          ) : (
            <ol className="flex flex-col">
              {timeline.map((e, i) => (
                <li key={`${e.memoryId}-${e.kind}-${e.at}`} className="flex gap-3">
                  {/* The rail: a continuous line with a dot per event, so the
                      order reads as time rather than as a list. */}
                  <div className="flex flex-col items-center">
                    <span
                      className={`mt-2 h-2 w-2 shrink-0 rounded-full ${EVENT_COLOUR[e.kind]}`}
                    />
                    {i < timeline.length - 1 && <span className="w-px flex-1 bg-white/10" />}
                  </div>
                  <div className="min-w-0 flex-1 pb-4">
                    <div className="flex flex-wrap items-baseline gap-2 text-[10px] font-mono text-white/30">
                      <span className={e.kind === 'replaced' ? 'text-amber-300/70' : ''}>
                        {EVENT_LABEL[e.kind]}
                      </span>
                      <span>{formatWhen(e.at)}</span>
                      {e.sourceSessionId && (
                        <Link
                          href={`/chat?session=${e.sourceSessionId}`}
                          className="underline decoration-dotted hover:text-white/60"
                        >
                          {e.sourceSessionTitle || 'Chat'}
                        </Link>
                      )}
                    </div>
                    <p
                      className={`text-sm leading-relaxed ${
                        e.kind === 'replaced' || e.kind === 'archived'
                          ? 'text-white/45 line-through decoration-white/20'
                          : 'text-white/85'
                      }`}
                    >
                      <LinkedContent text={e.content} />
                    </p>
                    {e.replacedBy && (
                      <p className="mt-1 text-xs text-white/60">
                        <span className="text-white/30">→ </span>
                        <LinkedContent text={e.replacedBy.content} />
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {/* --- The facts ------------------------------------------------------ */}
      {tab === 'facts' &&
        (loading ? (
          <div className="animate-pulse text-white/50">Lade…</div>
        ) : items.length === 0 ? (
          <div className="rounded-lg border border-white/10 bg-white/5 p-6 text-center text-white/50">
            Noch nichts gemerkt. Fakten entstehen im Chat, sobald etwas Dauerhaftes gesagt wird —
            oder oben von Hand.
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
        ))}

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
