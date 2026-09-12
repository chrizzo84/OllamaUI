/**
 * The knowledge base: what the assistant knows about the user, and how it
 * knows it.
 *
 * This used to be a table of strings read as `ORDER BY created_at DESC` and
 * cut to 50, injected whole into every prompt. That has four failure modes,
 * and all four are addressed here:
 *
 *  1. **Nothing could be updated.** There was create and delete, nothing in
 *     between, so "Ollama runs on the NUC" and "Ollama runs on
 *     192.0.2.10" sat side by side as equal truths and the model picked
 *     one. Now a fact has a `subject` — the thing it is *about* — and a new
 *     fact on the same subject **supersedes** the old one, which is kept as
 *     history rather than deleted. Same principle as message branching: the
 *     previous version stays reachable.
 *  2. **The most important fact was dropped first.** `LIMIT 50` on newest
 *     meant fact 51 pushed out the oldest — and the oldest is usually the
 *     most fundamental ("I'm called…", "I work with…"). Retrieval is now by
 *     relevance and role, with identity and pinned facts always present.
 *  3. **Everything was in every prompt.** Fifty facts about Docker while
 *     discussing dinner cost context window *and* attention; small local
 *     models degrade measurably with irrelevant context. Retrieval is now
 *     FTS-ranked against the conversation and capped by a token budget.
 *  4. **It was all one flat string type.** A durable trait, a current state
 *     and last week's event are different things with different lifetimes —
 *     "currently working on the Telegram formatting" is simply false three
 *     months later, but was presented as timeless fact.
 *
 * Contradictions are recorded, not silently resolved: when a new fact
 * replaces one that disagrees with it, a `contradicts` edge is written so
 * there is a list of exactly the places the knowledge base disagreed with
 * itself. That list is the review queue — and the hand-off point for a
 * consolidation pass that runs later.
 */
import { db } from './connection';
import { safeUuid } from '@/lib/utils';
import {
  parseWikiLinks,
  slugifyEntity,
  stripWikiLinks,
  normalizeClaim,
  estimateTokens,
} from '@/lib/memory-links';

export type MemoryType =
  'identity' | 'state' | 'preference' | 'episodic' | 'procedural' | 'unsorted';

export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'draft';

export type EdgeKind = 'about' | 'supersedes' | 'contradicts' | 'derived_from';
export type EdgeTarget = 'memory' | 'entity' | 'session';

export interface MemoryRow {
  id: string;
  content: string;
  type: MemoryType;
  subject: string | null;
  status: MemoryStatus;
  supersededBy: string | null;
  confidence: number;
  pinned: boolean;
  useCount: number;
  lastUsedAt: number | null;
  validFrom: number | null;
  validUntil: number | null;
  sourceSessionId: string | null;
  created_at: number;
  updated_at: number;
}

export interface EntityRow {
  id: string;
  label: string;
  created_at: number;
  updated_at: number;
}

export interface EdgeRow {
  id: string;
  fromId: string;
  toKind: EdgeTarget;
  toId: string;
  kind: EdgeKind;
  created_at: number;
  resolvedAt: number | null;
}

interface MemoryDbRow {
  id: string;
  content: string;
  type: string;
  subject: string | null;
  status: string;
  superseded_by: string | null;
  confidence: number;
  pinned: number;
  use_count: number;
  last_used_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  source_session_id: string | null;
  created_at: number;
  updated_at: number;
}

interface EdgeDbRow {
  id: string;
  from_id: string;
  to_kind: string;
  to_id: string;
  kind: string;
  created_at: number;
  resolved_at: number | null;
}

const MEMORY_TYPES: MemoryType[] = [
  'identity',
  'state',
  'preference',
  'episodic',
  'procedural',
  'unsorted',
];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as string[]).includes(value);
}

function rowToMemory(r: MemoryDbRow): MemoryRow {
  return {
    id: r.id,
    content: r.content,
    type: isMemoryType(r.type) ? r.type : 'unsorted',
    subject: r.subject,
    status: (r.status as MemoryStatus) ?? 'active',
    supersededBy: r.superseded_by,
    confidence: typeof r.confidence === 'number' ? r.confidence : 1,
    pinned: !!r.pinned,
    useCount: r.use_count ?? 0,
    lastUsedAt: r.last_used_at,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    sourceSessionId: r.source_session_id,
    created_at: r.created_at,
    updated_at: r.updated_at || r.created_at,
  };
}

function rowToEdge(r: EdgeDbRow): EdgeRow {
  return {
    id: r.id,
    fromId: r.from_id,
    toKind: r.to_kind as EdgeTarget,
    toId: r.to_id,
    kind: r.kind as EdgeKind,
    created_at: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

const SELECT_MEMORY = 'SELECT * FROM memories';

// --- Reading ---------------------------------------------------------------

/** Every memory, newest first — the Memory page's own listing. */
export function listMemories(options?: { status?: MemoryStatus }): MemoryRow[] {
  const rows = options?.status
    ? db.prepare(`${SELECT_MEMORY} WHERE status = ? ORDER BY created_at DESC`).all(options.status)
    : db.prepare(`${SELECT_MEMORY} ORDER BY created_at DESC`).all();
  return (rows as unknown as MemoryDbRow[]).map(rowToMemory);
}

export function getMemory(id: string): MemoryRow | undefined {
  const row = db.prepare(`${SELECT_MEMORY} WHERE id = ?`).get(id);
  return row ? rowToMemory(row as unknown as MemoryDbRow) : undefined;
}

/** The history of one subject, oldest first — what was believed, and when. */
export function listMemoryHistory(subject: string): MemoryRow[] {
  const rows = db
    .prepare(`${SELECT_MEMORY} WHERE subject = ? ORDER BY created_at ASC`)
    .all(subject);
  return (rows as unknown as MemoryDbRow[]).map(rowToMemory);
}

export function listEntities(): EntityRow[] {
  return db
    .prepare('SELECT * FROM entities ORDER BY label COLLATE NOCASE ASC')
    .all() as unknown as EntityRow[];
}

/** Everything said about one entity — the backlink view that makes this a knowledge base. */
export function listMemoriesForEntity(entityId: string): MemoryRow[] {
  const rows = db
    .prepare(
      `SELECT m.* FROM memories m
       JOIN memory_edges e ON e.from_id = m.id
       WHERE e.kind = 'about' AND e.to_kind = 'entity' AND e.to_id = ?
       ORDER BY m.created_at DESC`,
    )
    .all(entityId);
  return (rows as unknown as MemoryDbRow[]).map(rowToMemory);
}

export function listEdges(options?: { kind?: EdgeKind; unresolvedOnly?: boolean }): EdgeRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (options?.kind) {
    where.push('kind = ?');
    params.push(options.kind);
  }
  if (options?.unresolvedOnly) where.push('resolved_at IS NULL');
  const sql = `SELECT * FROM memory_edges${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC`;
  return (db.prepare(sql).all(...(params as never[])) as unknown as EdgeDbRow[]).map(rowToEdge);
}

/** Edges touching a memory in either direction — one hop of the graph around it. */
export function listEdgesForMemory(memoryId: string): EdgeRow[] {
  const rows = db
    .prepare(
      'SELECT * FROM memory_edges WHERE from_id = ? OR (to_kind = ? AND to_id = ?) ORDER BY created_at DESC',
    )
    .all(memoryId, 'memory', memoryId);
  return (rows as unknown as EdgeDbRow[]).map(rowToEdge);
}

/**
 * The open disagreements: pairs the knowledge base holds without having
 * decided between them. This is the review queue, and the most valuable
 * thing in the whole store — a contradiction nobody surfaces is just a
 * coin flip happening inside the prompt.
 */
export function listContradictions(): { edge: EdgeRow; newer?: MemoryRow; older?: MemoryRow }[] {
  return listEdges({ kind: 'contradicts', unresolvedOnly: true }).map((edge) => ({
    edge,
    newer: getMemory(edge.fromId),
    older: getMemory(edge.toId),
  }));
}

// --- Writing ---------------------------------------------------------------

function upsertEntity(slug: string, label: string, now: number): void {
  const existing = db.prepare('SELECT id FROM entities WHERE id = ?').get(slug);
  if (existing) {
    db.prepare('UPDATE entities SET updated_at = ? WHERE id = ?').run(now, slug);
    return;
  }
  db.prepare('INSERT INTO entities (id, label, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    slug,
    label,
    now,
    now,
  );
}

export function addEdge(
  fromId: string,
  toKind: EdgeTarget,
  toId: string,
  kind: EdgeKind,
  now = Date.now(),
): EdgeRow {
  const row: EdgeRow = {
    id: safeUuid(),
    fromId,
    toKind,
    toId,
    kind,
    created_at: now,
    resolvedAt: null,
  };
  db.prepare(
    'INSERT INTO memory_edges (id, from_id, to_kind, to_id, kind, created_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
  ).run(row.id, row.fromId, row.toKind, row.toId, row.kind, row.created_at);
  return row;
}

/** Marks a contradiction as settled — by a person, or by a later consolidation pass. */
export function resolveEdge(edgeId: string, now = Date.now()): void {
  db.prepare('UPDATE memory_edges SET resolved_at = ? WHERE id = ?').run(now, edgeId);
}

export interface RememberInput {
  content: string;
  type?: MemoryType;
  /**
   * What the fact is about. Given explicitly, or derived from the first
   * [[Wikilink]] in the content — which is the common case, since a fact
   * worth replacing is nearly always a fact about something nameable.
   */
  subject?: string | null;
  confidence?: number;
  sourceSessionId?: string | null;
  pinned?: boolean;
  validFrom?: number | null;
}

export interface RememberResult {
  memory: MemoryRow;
  /** The fact this one replaced, if any. */
  superseded?: MemoryRow;
  /** True when the claim was already stored and nothing new was written. */
  duplicate: boolean;
  /** True when the superseded fact said something genuinely different. */
  contradicted: boolean;
}

/**
 * Stores a fact, with the two rules that turn a list into a knowledge base:
 *
 *  - **Same claim, already known** → nothing is written, the existing fact is
 *    touched instead. Without this, "prefers short answers" accumulates once
 *    per conversation and slowly fills the prompt with one repeated sentence.
 *  - **Same subject, different claim** → the old fact is superseded (kept,
 *    marked, linked) and, when the claim actually differs, a `contradicts`
 *    edge records that the store changed its mind. Replacement is silent
 *    only for restatements; a real change is always traceable.
 *
 * A fact below the confidence gate lands as a `draft`: visible on the Memory
 * page for review, never injected into a prompt. Guessing quietly into the
 * long-term store is the one failure mode that compounds.
 */
export const DRAFT_CONFIDENCE_THRESHOLD = 0.5;

export function remember(input: RememberInput): RememberResult {
  const now = Date.now();
  const content = input.content.trim();
  const links = parseWikiLinks(content);
  const subject =
    input.subject === undefined
      ? (links[0]?.slug ?? null)
      : input.subject
        ? slugifyEntity(input.subject)
        : null;
  const confidence = Math.max(0, Math.min(1, input.confidence ?? 1));
  const type: MemoryType = input.type ?? 'unsorted';

  // Already known, in any wording: touch it rather than store it twice.
  const claim = normalizeClaim(content);
  const active = db
    .prepare(`${SELECT_MEMORY} WHERE status IN ('active','draft')`)
    .all() as unknown as MemoryDbRow[];
  const same = active.find((r) => normalizeClaim(r.content) === claim);
  if (same) {
    db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(now, same.id);
    return {
      memory: rowToMemory({ ...same, updated_at: now }),
      duplicate: true,
      contradicted: false,
    };
  }

  const row: MemoryRow = {
    id: safeUuid(),
    content,
    type,
    subject,
    status: confidence < DRAFT_CONFIDENCE_THRESHOLD ? 'draft' : 'active',
    supersededBy: null,
    confidence,
    pinned: !!input.pinned,
    useCount: 0,
    lastUsedAt: null,
    validFrom: input.validFrom ?? now,
    validUntil: null,
    sourceSessionId: input.sourceSessionId ?? null,
    created_at: now,
    updated_at: now,
  };

  db.prepare(
    `INSERT INTO memories
       (id, content, type, subject, status, superseded_by, confidence, pinned, use_count,
        last_used_at, valid_from, valid_until, source_session_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, ?, NULL, ?, ?, ?)`,
  ).run(
    row.id,
    row.content,
    row.type,
    row.subject,
    row.status,
    row.confidence,
    row.pinned ? 1 : 0,
    row.validFrom,
    row.sourceSessionId,
    row.created_at,
    row.updated_at,
  );

  // Entities and their edges — the graph, derived from the prose.
  for (const link of links) {
    upsertEntity(link.slug, link.label, now);
    addEdge(row.id, 'entity', link.slug, 'about', now);
  }
  if (row.sourceSessionId) addEdge(row.id, 'session', row.sourceSessionId, 'derived_from', now);

  // Displacement: one active fact per subject.
  let superseded: MemoryRow | undefined;
  let contradicted = false;
  if (subject && row.status === 'active') {
    const previous = db
      .prepare(
        `${SELECT_MEMORY} WHERE subject = ? AND status = 'active' AND id != ? ORDER BY created_at DESC`,
      )
      .all(subject, row.id) as unknown as MemoryDbRow[];
    for (const prev of previous) {
      db.prepare(
        "UPDATE memories SET status = 'superseded', superseded_by = ?, valid_until = ?, updated_at = ? WHERE id = ?",
      ).run(row.id, now, now, prev.id);
      addEdge(row.id, 'memory', prev.id, 'supersedes', now);
      // A restatement is not a contradiction; a different claim is.
      if (normalizeClaim(prev.content) !== claim) {
        addEdge(row.id, 'memory', prev.id, 'contradicts', now);
        contradicted = true;
      }
      if (!superseded) superseded = rowToMemory(prev);
    }
  }

  return { memory: row, superseded, duplicate: false, contradicted };
}

/**
 * How a contradiction is settled. The three answers a person actually has
 * when shown two facts that disagree:
 *
 *  - `newer` — what the store already assumed. The edge is just marked
 *    resolved.
 *  - `older` — the replacement was wrong. The two swap roles: the older fact
 *    becomes active again and the newer one is superseded by it. Without
 *    this, correcting a bad write means deleting it, which loses the record
 *    that the mistake happened.
 *  - `both` — they were never the same question. The older fact keeps its
 *    content but loses its subject, so it stops competing for the one active
 *    slot and simply stands on its own. Leaving both active *with* the same
 *    subject would mean the next write silently displaces only one of them.
 */
export type ContradictionResolution = 'newer' | 'older' | 'both';

export function resolveContradiction(
  edgeId: string,
  keep: ContradictionResolution,
  now = Date.now(),
): void {
  const edge = db.prepare('SELECT * FROM memory_edges WHERE id = ?').get(edgeId) as unknown as
    EdgeDbRow | undefined;
  if (!edge || edge.kind !== 'contradicts') return;
  const newerId = edge.from_id;
  const olderId = edge.to_id;

  if (keep === 'older') {
    db.prepare(
      "UPDATE memories SET status = 'active', superseded_by = NULL, valid_until = NULL, updated_at = ? WHERE id = ?",
    ).run(now, olderId);
    db.prepare(
      "UPDATE memories SET status = 'superseded', superseded_by = ?, valid_until = ?, updated_at = ? WHERE id = ?",
    ).run(olderId, now, now, newerId);
    // The supersedes edge pointed the wrong way round; re-point it so the
    // history reads as what actually happened.
    db.prepare(
      "DELETE FROM memory_edges WHERE kind = 'supersedes' AND from_id = ? AND to_id = ?",
    ).run(newerId, olderId);
    addEdge(olderId, 'memory', newerId, 'supersedes', now);
  } else if (keep === 'both') {
    db.prepare(
      "UPDATE memories SET status = 'active', superseded_by = NULL, valid_until = NULL, subject = NULL, updated_at = ? WHERE id = ?",
    ).run(now, olderId);
    db.prepare(
      "DELETE FROM memory_edges WHERE kind = 'supersedes' AND from_id = ? AND to_id = ?",
    ).run(newerId, olderId);
  }

  resolveEdge(edgeId, now);
}

/** Promotes a draft into the active store (the Memory page's approve button). */
export function approveMemory(id: string): MemoryRow | undefined {
  const now = Date.now();
  db.prepare(
    "UPDATE memories SET status = 'active', updated_at = ? WHERE id = ? AND status = 'draft'",
  ).run(now, id);
  return getMemory(id);
}

/**
 * Archive rather than delete: a fact that turned out to be wrong is itself
 * information ("it used to think X"), and the graph keeps its edges intact.
 * Hard deletion stays available for the Memory page's explicit delete.
 */
export function archiveMemory(id: string): void {
  db.prepare("UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?").run(
    Date.now(),
    id,
  );
}

/**
 * Re-classifies a fact from the Memory page — the one thing a person can do
 * that the model cannot do well: say what kind of fact this is. Setting a
 * subject makes it participate in displacement from then on; clearing it
 * takes it out of that competition.
 */
export function updateMemoryClassification(
  id: string,
  patch: { type?: MemoryType; subject?: string | null },
): MemoryRow | undefined {
  const now = Date.now();
  if (patch.type) {
    db.prepare('UPDATE memories SET type = ?, updated_at = ? WHERE id = ?').run(
      patch.type,
      now,
      id,
    );
  }
  if (patch.subject !== undefined) {
    const slug = patch.subject ? slugifyEntity(patch.subject) : null;
    db.prepare('UPDATE memories SET subject = ?, updated_at = ? WHERE id = ?').run(slug, now, id);
  }
  return getMemory(id);
}

export function setMemoryPinned(id: string, pinned: boolean): void {
  db.prepare('UPDATE memories SET pinned = ?, updated_at = ? WHERE id = ?').run(
    pinned ? 1 : 0,
    Date.now(),
    id,
  );
}

export function deleteMemory(id: string): void {
  db.prepare('DELETE FROM memory_edges WHERE from_id = ? OR (to_kind = ? AND to_id = ?)').run(
    id,
    'memory',
    id,
  );
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  pruneOrphanEntities();
}

/**
 * Drops entities nothing points at any more. An entity exists only as the
 * target of a link, so once the last memory mentioning it is gone the node
 * is not "a thing we know nothing about" — it is a leftover, and in a graph
 * view it is a floating dot with no edges. Superseded and archived memories
 * keep their edges, so a name stays on the map as long as anything in the
 * history still mentions it.
 */
export function pruneOrphanEntities(): number {
  const result = db
    .prepare(
      `DELETE FROM entities WHERE id NOT IN (
         SELECT to_id FROM memory_edges WHERE to_kind = 'entity'
       )`,
    )
    .run();
  return Number(result.changes ?? 0);
}

/**
 * Backwards-compatible entry point for the old call site
 * (`createMemory({ content, sourceSessionId })`). Kept so the existing
 * remember_fact tool keeps working unchanged while the typed path is wired
 * up.
 */
export function createMemory(data: {
  content: string;
  sourceSessionId?: string | null;
}): MemoryRow {
  return remember({ content: data.content, sourceSessionId: data.sourceSessionId }).memory;
}

// --- Retrieval -------------------------------------------------------------

export interface RecallOptions {
  /** The conversation text retrieval is ranked against. */
  query?: string;
  /** Hard cap on the memory block, in estimated tokens. */
  tokenBudget?: number;
  /** Upper bound on facts, whatever the budget allows. */
  limit?: number;
}

/**
 * What actually goes into the prompt.
 *
 * Identity and pinned facts are unconditional — they are few, they are
 * almost always relevant, and they are exactly what the old newest-50 window
 * silently dropped first. Everything else competes on relevance to the
 * current conversation, and the whole block is capped by a token budget
 * rather than a row count: a fact costs context, and on an 8k local model
 * fifty of them are a tenth of the window spent on things nobody asked
 * about.
 */
export function recallMemories(options: RecallOptions = {}): MemoryRow[] {
  const tokenBudget = options.tokenBudget ?? 800;
  const limit = options.limit ?? 40;

  const always = (
    db
      .prepare(
        `${SELECT_MEMORY} WHERE status = 'active' AND (type = 'identity' OR pinned = 1)
         ORDER BY pinned DESC, created_at ASC`,
      )
      .all() as unknown as MemoryDbRow[]
  ).map(rowToMemory);

  const chosen: MemoryRow[] = [];
  let spent = 0;
  const take = (m: MemoryRow) => {
    if (chosen.some((c) => c.id === m.id)) return;
    const cost = estimateTokens(m.content);
    if (chosen.length >= limit || spent + cost > tokenBudget) return;
    chosen.push(m);
    spent += cost;
  };
  always.forEach(take);

  const relevant = options.query ? searchMemories(options.query, limit) : [];
  relevant.forEach(take);

  /*
  Recency fills the gap only when relevance found nothing at all — an opening
  message, or a turn with no lexical overlap with anything stored. Filling
  leftover budget with "whatever is newest" whenever there is room is the
  same mistake this rewrite exists to fix, one layer further in: it spends
  the window on facts nobody asked about, and because the newest facts are
  usually the most trivial ones, it crowds out the ones that matter. Unused
  budget costs nothing; irrelevant context costs attention.
  */
  if (!relevant.length) {
    const recent = (
      db
        .prepare(
          `${SELECT_MEMORY} WHERE status = 'active' ORDER BY COALESCE(last_used_at, 0) DESC, created_at DESC LIMIT ?`,
        )
        .all(RECENCY_FALLBACK_LIMIT) as unknown as MemoryDbRow[]
    ).map(rowToMemory);
    recent.forEach(take);
  }

  return chosen;
}

/** Few on purpose — this is a cold start, not a reason to empty the store into the prompt. */
const RECENCY_FALLBACK_LIMIT = 5;

/*
Words that appear in nearly every sentence and rank nothing. Without this,
"Wie viel VRAM hat mein Server?" pulls in a memory about music because both
contain "viel" — a match on a word that carries no meaning is worse than no
match, since it costs a slot in a budget that is already tight. German and
English both, because the conversations here are both.
*/
const STOP_WORDS = new Set(
  (
    'der die das den dem des ein eine einen einem eines und oder aber auch noch nur schon mehr sehr ' +
    'ist sind war waren hat habe haben hatte wird werden kann können soll sollen muss müssen will ' +
    'ich du er sie es wir ihr mir mich dir dich ihm ihn uns euch sich man mein meine dein deine ' +
    'wie was wer wo wann warum welche welcher welches dass weil wenn dann als bei für mit von zum ' +
    'zur aus auf über unter vor nach seit gegen ohne um ins beim dem viel vielen viele etwas nichts ' +
    'heute gestern morgen jetzt immer nie oft mal gut gut ganz eigentlich the and for with from that ' +
    'this what when where how why does did has have had are was were will would can could should ' +
    'you your his her its our their about into over under just some any all not but they them'
  ).split(' '),
);

/**
 * Crude stemming by truncation: "koche", "kocht" and "kochen" all reduce to
 * the prefix "koch", which FTS5 then matches with `*`. German inflects at the
 * end of the word, so a real search ("Was koche ich heute?") otherwise misses
 * a fact stored as "kocht gern Pasta" — the single most common way this kind
 * of retrieval fails silently in German, and it looks like the memory was
 * never saved.
 *
 * Two characters off, but never below four: "koche" and "kocht" are five
 * characters, which is where German verb forms actually live, so a threshold
 * any higher misses exactly the words that matter. Four is the floor because
 * a three-letter prefix matches most of the store, and a match on everything
 * ranks nothing.
 */
function stemPrefix(word: string): string {
  return word.length > 4 ? word.slice(0, Math.max(4, word.length - 2)) : word;
}

/**
 * FTS5 relevance over memory content. The query is a chunk of conversation,
 * not a search box, so it is reduced to its distinct meaningful words and
 * OR-ed as prefixes — matching any of them is the point, and `bm25` ranks.
 */
export function searchMemories(query: string, limit = 20): MemoryRow[] {
  const terms = [
    ...new Set(
      normalizeClaim(query)
        .split(' ')
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
        .slice(0, 40),
    ),
  ];
  if (!terms.length) return [];
  const match = terms.map((t) => `"${stemPrefix(t)}"*`).join(' OR ');
  try {
    const rows = db
      .prepare(
        `SELECT m.* FROM memories_fts f
         JOIN memories m ON m.rowid = f.rowid
         WHERE memories_fts MATCH ? AND m.status = 'active'
         ORDER BY bm25(memories_fts) ASC
         LIMIT ?`,
      )
      .all(match, limit) as unknown as MemoryDbRow[];
    return rows.map(rowToMemory);
  } catch {
    // A malformed FTS query must never cost the caller its memory block.
    return [];
  }
}

/**
 * Records that these facts were actually used. This is the signal that says
 * which memories earn their place in the context window — and, inverted,
 * which have not been touched in months and belong in the archive.
 */
export function markMemoriesUsed(ids: string[], now = Date.now()): void {
  if (!ids.length) return;
  const stmt = db.prepare(
    'UPDATE memories SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
  );
  for (const id of ids) stmt.run(now, id);
}

/**
 * The memory block as the model sees it: grouped by role, link syntax
 * removed (the brackets are storage, and showing them only invites the model
 * to imitate them), newest first within a group.
 */
export function buildMemoryBlock(memories: MemoryRow[]): string {
  if (!memories.length) return '';
  const groups: [MemoryType | 'other', string][] = [
    ['identity', 'About this user'],
    ['preference', 'How they want you to work'],
    ['state', 'Current situation'],
    ['episodic', 'Things that happened'],
    ['other', 'Other notes'],
  ];
  const sections: string[] = [];
  for (const [type, heading] of groups) {
    const inGroup = memories.filter((m) =>
      type === 'other'
        ? !['identity', 'preference', 'state', 'episodic'].includes(m.type)
        : m.type === type,
    );
    if (!inGroup.length) continue;
    sections.push(
      `${heading}:\n${inGroup.map((m) => `- ${stripWikiLinks(m.content)}`).join('\n')}`,
    );
  }
  if (!sections.length) return '';
  return `${sections.join('\n\n')}\n\nUse these naturally when relevant; don't recite them unprompted. Only call remember_fact for genuinely new information, not for anything already listed here.`;
}
