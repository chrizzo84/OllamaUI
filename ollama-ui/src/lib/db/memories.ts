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

/**
 * The active fact a draft most resembles, if any is close enough to be worth
 * showing next to it.
 *
 * Between "clearly the same claim" (displaced automatically) and "clearly
 * different" there is a band where only a person can tell: "hat einen
 * Mini-PC mit 32 GB RAM" and "nutzt ein Homeserver-System mit Mini-PC und 32
 * GB RAM für lokale KI" overlap heavily and are not the same sentence — one
 * carries more. Deciding that automatically would either merge real detail
 * away or leave near-copies standing, so the review queue shows what a draft
 * resembles and lets the reader choose.
 */
const SIMILAR_ENOUGH_TO_SHOW = 0.3;

export function findSimilarActive(
  content: string,
  excludeId?: string,
): { memory: MemoryRow; similarity: number } | null {
  const rows = (
    db.prepare(`${SELECT_MEMORY} WHERE status = 'active'`).all() as unknown as MemoryDbRow[]
  ).map(rowToMemory);
  let best: { memory: MemoryRow; similarity: number } | null = null;
  for (const row of rows) {
    if (row.id === excludeId) continue;
    const similarity = claimSimilarity(row.content, content);
    if (similarity >= SIMILAR_ENOUGH_TO_SHOW && (!best || similarity > best.similarity)) {
      best = { memory: row, similarity };
    }
  }
  return best;
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

/**
 * Everything currently said about one entity — the backlink view that makes
 * this a knowledge base.
 *
 * Active only by default, and that default matters: a superseded fact listed
 * next to the one that replaced it reads as two competing truths, which is
 * exactly the impression this whole design exists to remove. `includeHistory`
 * is for the views that are explicitly about history.
 */
export function listMemoriesForEntity(
  entityId: string,
  options: { includeHistory?: boolean } = {},
): MemoryRow[] {
  const statuses = options.includeHistory
    ? ['active', 'draft', 'superseded', 'archived']
    : ['active'];
  const rows = db
    .prepare(
      // DISTINCT so a fact never appears twice in the backlinks just because
      // two edges happen to connect it to the same entity.
      `SELECT DISTINCT m.* FROM memories m
       JOIN memory_edges e ON e.from_id = m.id
       WHERE e.kind = 'about' AND e.to_kind = 'entity' AND e.to_id = ?
         AND m.status IN (${statuses.map(() => '?').join(',')})
       ORDER BY m.created_at DESC`,
    )
    .all(entityId, ...statuses);
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

/**
 * Entities the text names without bracketing them.
 *
 * Models are inconsistent about the [[link]] syntax — measured on
 * a local 35B model, the same fact came back with links in some runs and
 * without in others, and the focused extraction pass
 * (src/lib/memory-extract.ts) sets a subject reliably but almost never
 * brackets anything. Left at that, half the facts would never reach the
 * graph, and which half would be pure chance.
 *
 * So an entity that already exists is recognised wherever it is named,
 * whether or not this particular fact bothered to bracket it — Obsidian
 * calls these unlinked mentions. The fact's text is not rewritten: only the
 * edge is added, so what the model wrote is what stays stored.
 *
 * This heals forward rather than backward: the first mention of a thing has
 * to be bracketed by someone to create the entity, and every later mention
 * finds it. Short labels are skipped, where a substring match would connect
 * everything to everything.
 */
const MIN_MENTION_LENGTH = 3;

function unlinkedMentions(content: string, alreadyLinked: string[]): string[] {
  const plain = stripWikiLinks(content);
  const linked = new Set(alreadyLinked);
  const found: string[] = [];
  for (const entity of listEntities()) {
    if (linked.has(entity.id) || entity.label.length < MIN_MENTION_LENGTH) continue;
    // Word boundaries, so "[[Ollama]]" does not match inside "OllamaUI".
    const escaped = entity.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(plain)) {
      found.push(entity.id);
    }
  }
  return found;
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

/*
Words that carry no topic and would make any two sentences about the same
person look alike. Separate from the FTS stop words: this list only needs to
cover what recurs in *facts*, which are nearly all of the shape "Der Nutzer
<verb> <thing>".
*/
const CLAIM_NOISE = new Set(
  (
    'der die das den dem des ein eine einen einem eines und oder aber auch noch nur mit von zum zur ' +
    'aus auf uber unter vor nach seit gegen ohne um im in ist sind war hat habe haben wird werden ' +
    'kann er sie es ich du mein meine sein seine ihr ihre nutzer user the a an and or of for with ' +
    'his her their is are was has have uses user'
  ).split(' '),
);

function claimTokens(text: string): Set<string> {
  return new Set(
    normalizeClaim(text)
      .split(' ')
      // Numbers are kept whatever their length: they are often the only thing
      // separating two facts ("32 GB RAM" from "64 GB RAM", "8 GB" from
      // "12 GB"). Dropping them as too short made those look identical, and
      // the newer one silently displaced the older.
      .filter((w) => (w.length > 2 || /^\d+$/.test(w)) && !CLAIM_NOISE.has(w)),
  );
}

/**
 * How much two facts are about the same thing, 0 to 1.
 *
 * The subject was supposed to carry this on its own, and in practice does
 * not: the same machine came back as "hardware", "unraid-system" and
 * "grafikkarten" across three runs, so nothing displaced anything and the
 * store filled up with near-copies. A model will not name a subject
 * consistently across conversations, so the text has to be compared too.
 *
 * Deliberately lexical rather than semantic: an embedding call per write
 * would be another model round trip on the hot path, and overlap of content
 * words already separates "Der Nutzer wohnt in X" from "Der Nutzer besitzt
 * eine Y" cleanly.
 */
export function claimSimilarity(a: string, b: string): number {
  const ta = claimTokens(a);
  const tb = claimTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/**
 * Above this two facts are treated as being about the same thing, so the
 * newer one displaces the older exactly as a shared subject would.
 *
 * 0.6 rather than higher because the near-copies seen in practice sat around
 * 0.7–0.9 ("Der Nutzer wohnt in X" vs "Der Nutzer Alex wohnt in X"), and
 * rather than lower because two genuinely different facts about the same
 * machine ("hat eine GTX 1060" / "hat eine RTX 3060") land well below it.
 */
export const SAME_TOPIC_THRESHOLD = 0.6;

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
  /**
   * Entities named separately from the text, for writers that don't produce
   * inline [[links]] — the extraction pass in memory-extract.ts sets a
   * subject reliably and brackets almost nothing, which left the graph empty.
   * They become the same `about` edges a bracketed link would, without the
   * fact's wording being touched.
   */
  entities?: string[];
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
  // Explicit subject wins; otherwise the first thing the fact is about, from
  // a bracketed link or from the declared list. Without any of the three the
  // fact has no subject and can never be superseded, so this reaches for the
  // list too rather than leaving it null when the writer skipped brackets.
  const subject =
    input.subject === undefined
      ? (links[0]?.slug ?? (slugifyEntity(input.entities?.[0] ?? '') || null))
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

  // Entities and their edges — the graph, derived from the prose and from an
  // explicit list where the writer gave one.
  const declared = (input.entities ?? [])
    .map((label) => ({ label: label.trim(), slug: slugifyEntity(label) }))
    .filter((e) => e.slug);
  const seenEntities = new Set<string>();
  for (const link of [...links, ...declared]) {
    if (seenEntities.has(link.slug)) continue;
    seenEntities.add(link.slug);
    upsertEntity(link.slug, link.label, now);
    addEdge(row.id, 'entity', link.slug, 'about', now);
  }
  // Everything already connected above, bracketed or declared — otherwise the
  // mention scan finds the declared ones a second time and every entity ends
  // up with two identical edges.
  for (const slug of unlinkedMentions(content, [...seenEntities])) {
    addEdge(row.id, 'entity', slug, 'about', now);
  }
  if (row.sourceSessionId) addEdge(row.id, 'session', row.sourceSessionId, 'derived_from', now);

  // Displacement: one active fact per subject.
  let superseded: MemoryRow | undefined;
  let contradicted = false;
  if (row.status === 'active') {
    /*
    Two ways to be about the same thing: the same subject, or simply saying
    nearly the same words. The second exists because the first cannot be
    relied on — the same machine was subject "hardware" in one run,
    "unraid-system" in the next, so nothing ever displaced anything and the
    store filled with near-copies.
    */
    const candidates = (
      db
        .prepare(`${SELECT_MEMORY} WHERE status = 'active' AND id != ?`)
        .all(row.id) as unknown as MemoryDbRow[]
    ).filter(
      (prev) =>
        (subject && prev.subject === subject) ||
        claimSimilarity(prev.content, content) >= SAME_TOPIC_THRESHOLD,
    );
    const previous = candidates.sort((a, b) => b.created_at - a.created_at);
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
/**
 * Promotes a draft into the active store — and runs the displacement it
 * skipped while it was a draft.
 *
 * A draft deliberately displaces nothing: it is not in use, so it must not
 * push out something that is. But approving it makes it a current fact, and
 * without this the store ended up with two active facts on the same subject
 * standing side by side — exactly the situation the whole design exists to
 * prevent. Seen live: "Der Nutzer wohnt in X" approved next to "Der Nutzer
 * Alex wohnt in X", both marked current, both on subject "wohnort".
 */
export function approveMemory(id: string): MemoryRow | undefined {
  const now = Date.now();
  const draft = getMemory(id);
  if (!draft || draft.status !== 'draft') return draft;
  db.prepare("UPDATE memories SET status = 'active', updated_at = ? WHERE id = ?").run(now, id);

  const rivals = (
    db
      .prepare(`${SELECT_MEMORY} WHERE status = 'active' AND id != ?`)
      .all(id) as unknown as MemoryDbRow[]
  ).filter(
    (other) =>
      (draft.subject && other.subject === draft.subject) ||
      claimSimilarity(other.content, draft.content) >= SAME_TOPIC_THRESHOLD,
  );
  const claim = normalizeClaim(draft.content);
  for (const rival of rivals) {
    db.prepare(
      "UPDATE memories SET status = 'superseded', superseded_by = ?, valid_until = ?, updated_at = ? WHERE id = ?",
    ).run(id, now, now, rival.id);
    addEdge(id, 'memory', rival.id, 'supersedes', now);
    if (normalizeClaim(rival.content) !== claim) {
      addEdge(id, 'memory', rival.id, 'contradicts', now);
    }
  }
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

// --- The graph -------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: 'memory' | 'entity';
  label: string;
  /** memory only */
  type?: MemoryType;
  status?: MemoryStatus;
  useCount?: number;
  pinned?: boolean;
  /** entity only: how many memories point at it */
  degree?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  resolved: boolean;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Nodes left out because the neighbourhood was capped. */
  truncated: number;
}

export interface GraphOptions {
  /** Node id to centre on. Without one, the whole (capped) graph is returned. */
  focus?: string;
  /** How far from the focus to walk. */
  hops?: number;
  /** Include superseded and archived memories — the history, greyed out in the UI. */
  includeHistory?: boolean;
  /** Hard ceiling, because a hairball is not a view. */
  limit?: number;
}

/**
 * The knowledge graph, as nodes and edges.
 *
 * Deliberately neighbourhood-first rather than "render everything": a
 * force-directed picture of a few hundred nodes is famously pretty and
 * famously useless, and the questions actually worth asking here are local
 * ones — what does this fact connect to, what disagrees with what, what do
 * we know about this thing. Without a focus it still returns a capped
 * overview, so the first look isn't an empty canvas.
 *
 * `derived_from` edges (fact → session) are left out: a session is not a
 * node in this graph, and drawing one per fact would double the node count
 * with nothing to learn from it. The source conversation is a link on the
 * fact instead.
 */
export function buildGraph(options: GraphOptions = {}): GraphData {
  const limit = options.limit ?? 250;
  const hops = Math.max(1, Math.min(3, options.hops ?? 2));
  const statuses = options.includeHistory
    ? ['active', 'draft', 'superseded', 'archived']
    : ['active', 'draft'];

  const memories = new Map(
    (
      db
        .prepare(`${SELECT_MEMORY} WHERE status IN (${statuses.map(() => '?').join(',')})`)
        .all(...statuses) as unknown as MemoryDbRow[]
    )
      .map(rowToMemory)
      .map((m) => [m.id, m] as const),
  );
  const entities = new Map(listEntities().map((e) => [e.id, e] as const));

  // Only edges whose endpoints both survived the status filter — a
  // supersedes edge pointing at a hidden历史 row would otherwise render as a
  // line into nowhere.
  const allEdges = listEdges().filter((e) => {
    if (e.kind === 'derived_from') return false;
    if (!memories.has(e.fromId)) return false;
    return e.toKind === 'entity' ? entities.has(e.toId) : memories.has(e.toId);
  });

  const nodeId = (kind: 'memory' | 'entity', id: string) => `${kind}:${id}`;
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  for (const e of allEdges) {
    link(nodeId('memory', e.fromId), nodeId(e.toKind === 'entity' ? 'entity' : 'memory', e.toId));
  }

  let keep: Set<string>;
  if (options.focus && adjacency.has(options.focus)) {
    keep = new Set([options.focus]);
    let frontier = [options.focus];
    for (let i = 0; i < hops && keep.size < limit; i++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const neighbour of adjacency.get(id) ?? []) {
          if (keep.has(neighbour) || keep.size >= limit) continue;
          keep.add(neighbour);
          next.push(neighbour);
        }
      }
      frontier = next;
    }
  } else if (options.focus) {
    // A node with no edges at all is still a valid focus — it just has an
    // empty neighbourhood, which is itself worth seeing.
    keep = new Set([options.focus]);
  } else {
    /*
    No focus: prefer what the graph is actually about. Entities with the most
    connections and memories that retrieval actually uses say more than the
    newest rows, which on a big store are mostly trivia.
    */
    const ranked = [
      ...[...entities.keys()].map((id) => ({
        id: nodeId('entity', id),
        weight: (adjacency.get(nodeId('entity', id))?.size ?? 0) * 10,
      })),
      ...[...memories.values()].map((m) => ({
        id: nodeId('memory', m.id),
        weight:
          m.useCount + (m.pinned ? 5 : 0) + (adjacency.get(nodeId('memory', m.id))?.size ?? 0),
      })),
    ].sort((a, b) => b.weight - a.weight);
    keep = new Set(ranked.slice(0, limit).map((r) => r.id));
  }

  const nodes: GraphNode[] = [];
  for (const id of keep) {
    const [kind, rest] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    if (kind === 'entity') {
      const entity = entities.get(rest);
      if (!entity) continue;
      nodes.push({
        id,
        kind: 'entity',
        label: entity.label,
        degree: adjacency.get(id)?.size ?? 0,
      });
    } else {
      const memory = memories.get(rest);
      if (!memory) continue;
      nodes.push({
        id,
        kind: 'memory',
        label: stripWikiLinks(memory.content),
        type: memory.type,
        status: memory.status,
        useCount: memory.useCount,
        pinned: memory.pinned,
      });
    }
  }

  const edges: GraphEdge[] = allEdges
    .map((e) => ({
      id: e.id,
      source: nodeId('memory', e.fromId),
      target: nodeId(e.toKind === 'entity' ? 'entity' : 'memory', e.toId),
      kind: e.kind,
      resolved: e.resolvedAt !== null,
    }))
    .filter((e) => keep.has(e.source) && keep.has(e.target));

  const total = memories.size + entities.size;
  return { nodes, edges, truncated: Math.max(0, total - nodes.length) };
}

export type TimelineEventKind = 'learned' | 'replaced' | 'archived' | 'drafted';

export interface TimelineEvent {
  at: number;
  kind: TimelineEventKind;
  memoryId: string;
  content: string;
  type: MemoryType;
  subject: string | null;
  sourceSessionId: string | null;
  /** For a replacement: what took its place. */
  replacedBy?: { id: string; content: string };
}

/**
 * What happened to the knowledge base, in order.
 *
 * A memory store has a timeline whether anyone draws it or not, and "when did
 * it learn this" is usually the answer to "why does it think that". The
 * events are derived rather than logged: a row's created_at is when it was
 * learned, its valid_until is when it stopped being true, and the status says
 * how it ended. Deriving them means there is no second source of truth to
 * drift out of sync with the facts themselves.
 */
export function listTimeline(limit = 200): TimelineEvent[] {
  const rows = (
    db
      .prepare(`${SELECT_MEMORY} ORDER BY created_at DESC LIMIT ?`)
      .all(limit * 2) as unknown as MemoryDbRow[]
  ).map(rowToMemory);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const events: TimelineEvent[] = [];
  for (const m of rows) {
    const base = {
      memoryId: m.id,
      content: m.content,
      type: m.type,
      subject: m.subject,
      sourceSessionId: m.sourceSessionId,
    };
    events.push({ ...base, at: m.created_at, kind: m.status === 'draft' ? 'drafted' : 'learned' });
    if (m.status === 'superseded' && m.validUntil) {
      const successor = m.supersededBy ? byId.get(m.supersededBy) : undefined;
      events.push({
        ...base,
        at: m.validUntil,
        kind: 'replaced',
        replacedBy: successor ? { id: successor.id, content: successor.content } : undefined,
      });
    }
    if (m.status === 'archived') {
      events.push({ ...base, at: m.updated_at, kind: 'archived' });
    }
  }
  return events.sort((a, b) => b.at - a.at).slice(0, limit);
}

export function getEntity(id: string): EntityRow | undefined {
  return db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
}

/** Entities with how much is known about each — the list view's ordering. */
export function listEntitiesWithCounts(): (EntityRow & { memoryCount: number })[] {
  return db
    .prepare(
      `SELECT e.*, COUNT(DISTINCT m.id) AS memoryCount
       FROM entities e
       LEFT JOIN memory_edges edge
         ON edge.to_kind = 'entity' AND edge.to_id = e.id AND edge.kind = 'about'
       LEFT JOIN memories m ON m.id = edge.from_id AND m.status = 'active'
       GROUP BY e.id
       ORDER BY memoryCount DESC, e.label COLLATE NOCASE ASC`,
    )
    .all() as unknown as (EntityRow & { memoryCount: number })[];
}

// --- Maintenance ------------------------------------------------------------

export interface MaintenanceRunRow {
  id: string;
  trigger: 'schedule' | 'manual';
  status: 'running' | 'done' | 'stopped' | 'error';
  model: string | null;
  startedAt: number;
  finishedAt: number | null;
  conversationsRead: number;
  factsFound: number;
  mergesProposed: number;
  archived: number;
  error: string | null;
}

interface MaintenanceDbRow {
  id: string;
  trigger: string;
  status: string;
  model: string | null;
  started_at: number;
  finished_at: number | null;
  conversations_read: number;
  facts_found: number;
  merges_proposed: number;
  archived: number;
  error: string | null;
}

function rowToRun(r: MaintenanceDbRow): MaintenanceRunRow {
  return {
    id: r.id,
    trigger: r.trigger as 'schedule' | 'manual',
    status: r.status as MaintenanceRunRow['status'],
    model: r.model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    conversationsRead: r.conversations_read,
    factsFound: r.facts_found,
    mergesProposed: r.merges_proposed,
    archived: r.archived,
    error: r.error,
  };
}

export function startMaintenanceRun(trigger: 'schedule' | 'manual', model: string | null): string {
  const id = safeUuid();
  db.prepare(
    `INSERT INTO memory_maintenance_runs (id, trigger, status, model, started_at)
     VALUES (?, ?, 'running', ?, ?)`,
  ).run(id, trigger, model, Date.now());
  return id;
}

export function updateMaintenanceRun(
  id: string,
  patch: Partial<{
    status: MaintenanceRunRow['status'];
    conversationsRead: number;
    factsFound: number;
    mergesProposed: number;
    archived: number;
    error: string | null;
    finished: boolean;
  }>,
): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  for (const [key, column] of [
    ['conversationsRead', 'conversations_read'],
    ['factsFound', 'facts_found'],
    ['mergesProposed', 'merges_proposed'],
    ['archived', 'archived'],
  ] as const) {
    const value = patch[key];
    if (typeof value === 'number') {
      sets.push(`${column} = ?`);
      values.push(value);
    }
  }
  if (patch.error !== undefined) {
    sets.push('error = ?');
    values.push(patch.error);
  }
  if (patch.finished) {
    sets.push('finished_at = ?');
    values.push(Date.now());
  }
  if (!sets.length) return;
  db.prepare(`UPDATE memory_maintenance_runs SET ${sets.join(', ')} WHERE id = ?`).run(
    ...(values as never[]),
    id,
  );
}

export function listMaintenanceRuns(limit = 20): MaintenanceRunRow[] {
  const rows = db
    .prepare('SELECT * FROM memory_maintenance_runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as unknown as MaintenanceDbRow[];
  return rows.map(rowToRun);
}

/**
 * Episodic facts nobody has looked at in a long time.
 *
 * Only episodic decays automatically, and only when retrieval has never
 * reached for it. An episodic fact is tied to a moment by definition — "war
 * im Mai auf der FOSDEM" is true forever and interesting for a while — so
 * letting it age out is honest. Identity, preferences and state are left
 * alone: a preference nobody happened to ask about this quarter has not
 * stopped being true, and archiving it unattended would quietly change how
 * the assistant behaves.
 *
 * Archived rather than deleted, so the timeline still shows it happened.
 */
export function listDecayableMemories(olderThanMs: number, now = Date.now()): MemoryRow[] {
  const cutoff = now - olderThanMs;
  const rows = db
    .prepare(
      `${SELECT_MEMORY} WHERE status = 'active' AND type = 'episodic' AND pinned = 0
         AND use_count = 0 AND created_at < ?
       ORDER BY created_at ASC`,
    )
    .all(cutoff) as unknown as MemoryDbRow[];
  return rows.map(rowToMemory);
}

/**
 * Pairs of active facts that overlap enough to be worth a second look but not
 * enough for displacement to have handled them — the band the write path
 * deliberately stays out of, collected here so a maintenance pass can offer a
 * merged wording.
 */
export function listMergeCandidates(
  limit = 10,
): { a: MemoryRow; b: MemoryRow; similarity: number }[] {
  const active = (
    db.prepare(`${SELECT_MEMORY} WHERE status = 'active'`).all() as unknown as MemoryDbRow[]
  ).map(rowToMemory);
  const pairs: { a: MemoryRow; b: MemoryRow; similarity: number }[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const similarity = claimSimilarity(active[i].content, active[j].content);
      if (similarity >= MERGE_CANDIDATE_FLOOR && similarity < SAME_TOPIC_THRESHOLD) {
        pairs.push({ a: active[i], b: active[j], similarity });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity - x.similarity).slice(0, limit);
}

/** Below this two facts are simply different; above SAME_TOPIC_THRESHOLD the write path already displaced one. */
const MERGE_CANDIDATE_FLOOR = 0.35;

// --- The backfill over past conversations ----------------------------------

export interface ScanCandidate {
  messageId: string;
  sessionId: string;
  content: string;
  /** The reply immediately before it — an answer needs its question to mean anything. */
  priorAssistantText: string | null;
  created_at: number;
}

/**
 * User messages the fact extractor has never looked at, oldest first.
 *
 * The per-reply pass only sees the message it is answering, so everything
 * said before the memory existed is unexamined — and that is usually where
 * the durable facts are, since people explain their setup once, early.
 *
 * Oldest first on purpose: facts arrive in the order they were true, so
 * processing them in order lets a later fact supersede an earlier one
 * exactly as it would have live. Running newest-first would leave the
 * outdated version as the active one.
 */
export function listUnscannedMessages(limit = 500): ScanCandidate[] {
  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.content, m.created_at, m.parent_id
       FROM messages m
       LEFT JOIN memory_scans s ON s.message_id = m.id
       WHERE m.role = 'user' AND s.message_id IS NULL AND TRIM(m.content) != ''
       ORDER BY m.created_at ASC
       LIMIT ?`,
    )
    .all(limit) as unknown as {
    id: string;
    session_id: string;
    content: string;
    created_at: number;
    parent_id: string | null;
  }[];

  const priorStmt = db.prepare("SELECT content FROM messages WHERE id = ? AND role = 'assistant'");
  return rows.map((r) => {
    const prior = r.parent_id
      ? (priorStmt.get(r.parent_id) as { content?: string } | undefined)
      : undefined;
    return {
      messageId: r.id,
      sessionId: r.session_id,
      content: r.content,
      // History is a tree: the message a user message hangs off *is* the
      // reply it followed, which is more reliable than "the previous row by
      // timestamp" once a conversation has branches.
      priorAssistantText: prior?.content?.trim() ? prior.content : null,
      created_at: r.created_at,
    };
  });
}

export interface ScanConversation {
  sessionId: string;
  /** Every turn of the conversation, for context. */
  turns: { role: 'user' | 'assistant'; content: string }[];
  /** Only the user messages that still need marking — the ones this run is for. */
  messageIds: string[];
  created_at: number;
}

/**
 * Unexamined user messages grouped into the conversations they belong to,
 * oldest conversation first.
 *
 * Reading a whole conversation at once rather than message by message was
 * worth measuring: on the same ten-turn conversation a local 35B model found
 * one fact in five calls message-by-message, and three in a single call from
 * the transcript. The extra facts come from context a single message cannot
 * carry, and one call per conversation instead of one per message is the
 * difference between minutes and an hour over a long history.
 *
 * The full turn list is returned for context; only `messageIds` gets marked,
 * so a conversation that grows later is picked up again for its new messages
 * alone.
 */
export function listUnscannedConversations(limit = 50): ScanConversation[] {
  const pending = listUnscannedMessages(2000);
  if (!pending.length) return [];

  const bySession = new Map<string, ScanCandidate[]>();
  for (const c of pending) {
    const list = bySession.get(c.sessionId) ?? [];
    list.push(c);
    bySession.set(c.sessionId, list);
  }

  const conversations: ScanConversation[] = [];
  for (const [sessionId, candidates] of bySession) {
    const rows = db
      .prepare(
        `SELECT role, content FROM messages
         WHERE session_id = ? AND role IN ('user','assistant') AND TRIM(content) != ''
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as unknown as { role: string; content: string }[];
    conversations.push({
      sessionId,
      turns: rows.map((r) => ({ role: r.role as 'user' | 'assistant', content: r.content })),
      messageIds: candidates.map((c) => c.messageId),
      created_at: Math.min(...candidates.map((c) => c.created_at)),
    });
  }
  return conversations.sort((a, b) => a.created_at - b.created_at).slice(0, limit);
}

export function countUnscannedConversations(): number {
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT m.session_id) AS c FROM messages m
       LEFT JOIN memory_scans s ON s.message_id = m.id
       WHERE m.role = 'user' AND s.message_id IS NULL AND TRIM(m.content) != ''`,
    )
    .get() as { c: number };
  return row?.c ?? 0;
}

export function countUnscannedMessages(): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM messages m
       LEFT JOIN memory_scans s ON s.message_id = m.id
       WHERE m.role = 'user' AND s.message_id IS NULL AND TRIM(m.content) != ''`,
    )
    .get() as { c: number };
  return row?.c ?? 0;
}

/** Marks a message as examined, whatever the outcome — including "nothing found". */
export function markMessageScanned(messageId: string, found: number, now = Date.now()): void {
  db.prepare(
    'INSERT OR REPLACE INTO memory_scans (message_id, scanned_at, found) VALUES (?, ?, ?)',
  ).run(messageId, now, found);
}

/**
 * Marks the user message an assistant reply answers as examined.
 *
 * The live pass has the reply's id, not the question's — but history is a
 * tree and the reply hangs off exactly that question, so the parent link is
 * the answer. Without this the backfill reads the same conversation again
 * later and stores the same fact in different words, which is how the store
 * filled up with near-duplicates.
 *
 * Silent when the reply has no parent (the very first message of a
 * conversation, or a row written before this existed): nothing is worth
 * failing a finished reply over.
 */
export function markAnsweredMessageScanned(assistantMessageId: string, now = Date.now()): void {
  const row = db
    .prepare("SELECT parent_id FROM messages WHERE id = ? AND role = 'assistant'")
    .get(assistantMessageId) as { parent_id?: string | null } | undefined;
  if (!row?.parent_id) return;
  const parent = db
    .prepare("SELECT id FROM messages WHERE id = ? AND role = 'user'")
    .get(row.parent_id) as { id?: string } | undefined;
  if (parent?.id) markMessageScanned(parent.id, 0, now);
}

export function countScannedMessages(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM memory_scans').get() as { c: number };
  return row?.c ?? 0;
}

/**
 * Forgets that anything was scanned, so the next run re-reads everything.
 * For when the extraction itself has changed and old verdicts are worth
 * revisiting — the drafts it produced are not touched.
 */
export function clearScanHistory(): void {
  db.prepare('DELETE FROM memory_scans').run();
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
/**
 * Retrieval, plus which facts were chosen *because they matched the
 * conversation* rather than because they are pinned or grounding.
 *
 * The distinction decides what counts as "used". Counting a fact every time
 * it rides along unconditionally would make the use count meaningless — the
 * facts that are always present would always win it, which is both a lie
 * about what the model leaned on and a feedback loop into any ranking or
 * decay built on top of it.
 */
export function recallWithProvenance(options: RecallOptions = {}): {
  memories: MemoryRow[];
  matchedByRelevance: string[];
} {
  const tokenBudget = options.tokenBudget ?? 800;
  const limit = options.limit ?? 40;

  const chosen: MemoryRow[] = [];
  let spent = 0;
  const take = (m: MemoryRow, ceiling = tokenBudget): boolean => {
    if (chosen.some((c) => c.id === m.id)) return false;
    const cost = estimateTokens(m.content);
    if (chosen.length >= limit || spent + cost > ceiling) return false;
    chosen.push(m);
    spent += cost;
    return true;
  };

  /*
  Pinned facts are unconditional, because a person said so. Nothing else is:
  "durable" and "relevant to every question" are different axes, and
  conflating them is what the first version got wrong. Every `identity` fact
  went into every prompt, so a store with forty durable facts — a bike, a
  cat, a camera — spent the whole budget on them and pushed out the one fact
  the question was actually about. Measured: 40 identity facts, 0 room left
  for the backup fact someone had just asked about.
  */
  const pinned = (
    db
      .prepare(`${SELECT_MEMORY} WHERE status = 'active' AND pinned = 1 ORDER BY created_at ASC`)
      .all() as unknown as MemoryDbRow[]
  ).map(rowToMemory);
  pinned.forEach((m) => take(m));

  /*
  A small guaranteed share for the facts that shape *how* to answer rather
  than what to answer — a name, a language, a preferred tone. Without any
  reservation a memory with no pins would eventually stop knowing the user's
  name; with an unbounded one the original bug returns. Oldest first inside
  that share, because the fundamentals are stated early: "heißt X", "schreibt
  auf Deutsch".
  */
  const groundingCeiling = spent + Math.floor(tokenBudget * GROUNDING_SHARE);
  const grounding = (
    db
      .prepare(
        `${SELECT_MEMORY} WHERE status = 'active' AND pinned = 0
           AND type IN ('identity','preference')
         ORDER BY created_at ASC LIMIT ?`,
      )
      .all(GROUNDING_LIMIT) as unknown as MemoryDbRow[]
  ).map(rowToMemory);
  for (const m of grounding) take(m, groundingCeiling);

  // Everything else competes on relevance to the conversation, with the rest
  // of the budget.
  /*
  Two ways to be relevant, and the entity one goes first because it is the
  stronger signal: naming a thing is a more deliberate act than sharing a
  word with a sentence.
  */
  const byEntity = options.query ? recallByEntity(options.query, limit) : [];
  const byWords = options.query ? searchMemories(options.query, limit) : [];
  const relevant = [...byEntity, ...byWords.filter((m) => !byEntity.some((e) => e.id === m.id))];
  const matchedByRelevance: string[] = [];
  for (const m of relevant) if (take(m)) matchedByRelevance.push(m.id);

  /*
  Recency fills the gap only when relevance found nothing at all — an opening
  message, or a turn with no lexical overlap with anything stored. Filling
  leftover budget with "whatever is newest" whenever there is room is the
  same mistake one layer further in: it spends the window on facts nobody
  asked about. Unused budget costs nothing; irrelevant context costs
  attention.
  */
  if (!relevant.length) {
    const recent = (
      db
        .prepare(
          `${SELECT_MEMORY} WHERE status = 'active' ORDER BY COALESCE(last_used_at, 0) DESC, created_at DESC LIMIT ?`,
        )
        .all(RECENCY_FALLBACK_LIMIT) as unknown as MemoryDbRow[]
    ).map(rowToMemory);
    recent.forEach((m) => take(m));
  }

  return { memories: chosen, matchedByRelevance };
}

/**
 * What retrieval picked, without the provenance. Kept because most callers
 * only want the facts.
 */
export function recallMemories(options: RecallOptions = {}): MemoryRow[] {
  return recallWithProvenance(options).memories;
}

/**
 * Share of the budget reserved for identity and preference facts that are not
 * pinned. A quarter is enough for a handful of short grounding facts and
 * leaves the majority to whatever the conversation is actually about.
 */
const GROUNDING_SHARE = 0.25;

/**
 * And a hard count on top of the share, because grounding facts are *few* by
 * nature — a name, a language, a preferred tone. With only a token ceiling,
 * short facts filled it: measured on a store of forty durable facts, the
 * reserve was spent on nineteen belongings before the question's own fact
 * got a look in. Anyone wanting more than this in every prompt can pin it,
 * which is a deliberate act rather than an accident of ordering.
 *
 * Oldest first rather than most-used: the fundamentals are stated early
 * ("heißt X", "schreibt auf Deutsch"), and ordering by use count would be
 * self-reinforcing — a fact carried into every prompt is counted as used
 * every time, so it would keep its place forever on the strength of having
 * had it.
 */
const GROUNDING_LIMIT = 4;

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
 * Facts attached to any entity the text names.
 *
 * The graph was only ever drawn, never used. But an entity is exactly the
 * thing a question is *about*, and word matching alone misses the connection:
 * asked "läuft das noch auf dem Server im Keller?", FTS finds facts
 * containing "Server" and misses "Backups laufen jede Nacht auf den
 * [[Homeserver]]" unless the wording happens to line up. Matching the named
 * things instead pulls in everything known about them.
 *
 * Entity labels are matched on word boundaries against the conversation, so
 * a two-letter name cannot match half the store — the same floor the
 * unlinked-mention scan uses.
 */
export function recallByEntity(query: string, limit = 10): MemoryRow[] {
  const plain = normalizeClaim(query);
  if (!plain) return [];
  const hits: string[] = [];
  for (const entity of listEntities()) {
    const slug = entity.id;
    if (slug.length < MIN_MENTION_LENGTH) continue;
    const label = normalizeClaim(entity.label);
    if (!label) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
      'u',
    );
    if (pattern.test(plain)) hits.push(slug);
  }
  if (!hits.length) return [];
  const placeholders = hits.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT DISTINCT m.* FROM memories m
       JOIN memory_edges e ON e.from_id = m.id
       WHERE e.kind = 'about' AND e.to_kind = 'entity' AND e.to_id IN (${placeholders})
         AND m.status = 'active'
       ORDER BY m.use_count DESC, m.created_at DESC
       LIMIT ?`,
    )
    .all(...hits, limit) as unknown as MemoryDbRow[];
  return rows.map(rowToMemory);
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
