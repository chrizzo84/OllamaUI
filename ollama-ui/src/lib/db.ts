/**
 * Persistent storage via SQLite (data/app.db), using Node's built-in
 * `node:sqlite` module — no native addon, no compile step, so none of the
 * cross-platform/Docker build problems that came with `better-sqlite3`
 * (removed in an earlier revision) apply here. Requires Node >= 22.5.
 *
 * NOTE: `next dev` must run without `--turbopack` — Turbopack's dev bundler
 * (as of Next.js 16.2.4) cannot load `node:sqlite` at all, whether via a
 * static `import`, `require()`, or a dynamically-built module name (all
 * three fail with different errors). `next build`/`next start` already use
 * webpack, which handles it fine, so this only affects local dev.
 *
 * The actual DB connection/schema/migration is created LAZILY (see `db`
 * below), not at module top-level: `next build`'s "Collecting page data"
 * step imports every route module (including this one, transitively) in
 * several parallel worker processes just to inspect it, without ever
 * calling a handler. Opening + migrating the database eagerly at import
 * time meant every one of those workers raced to write the same fresh
 * `app.db` simultaneously, which fails with SQLite errors like "attempt to
 * write a readonly database" / "disk I/O error". Deferring all of this
 * until the first real `db.prepare(...)` call (i.e. an actual request at
 * runtime) means plain module import is side-effect-free.
 */
import { DatabaseSync } from 'node:sqlite';
import { safeUuid } from '@/lib/utils';
import type { ChatMessage } from '@/store/chat';
import path from 'path';
import fs from 'fs';

const dataDir = path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'app.db');
const lamasJsonFile = path.join(dataDir, 'lamas.json');
const hostsJsonFile = path.join(dataDir, 'hosts.json');
const sessionsJsonFile = path.join(dataDir, 'sessions.json');

// A pre-existing app.db without a `sessions` table predates this schema
// entirely (it's the file left over from before the brief JSON-file era) —
// replace it rather than trying to reuse an unknown legacy shape. The JSON
// files are the real current source of truth, migrated in below.
function isLegacyDb(): boolean {
  if (!fs.existsSync(dbFile)) return false;
  try {
    const probe = new DatabaseSync(dbFile);
    const row = probe
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'")
      .get();
    probe.close();
    return !row;
  } catch {
    return true;
  }
}

let realDb: DatabaseSync | null = null;

function initDb(): DatabaseSync {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  if (isLegacyDb()) {
    for (const f of [dbFile, `${dbFile}-shm`, `${dbFile}-wal`]) {
      if (fs.existsSync(f)) fs.rmSync(f);
    }
  }

  const instance = new DatabaseSync(dbFile);
  instance.exec(`
    CREATE TABLE IF NOT EXISTS lamas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      title_status TEXT NOT NULL DEFAULT 'pending',
      profile_id TEXT,
      model_a TEXT NOT NULL DEFAULT '',
      model_b TEXT NOT NULL DEFAULT '',
      compare_mode INTEGER NOT NULL DEFAULT 0,
      messages TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source_session_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchmark_runs (
      id TEXT PRIMARY KEY,
      model TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'chat',
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      tokens_per_second REAL,
      created_at INTEGER NOT NULL
    );
  `);
  // `sessions` predates the per-session memory override — a plain `CREATE
  // TABLE IF NOT EXISTS` above won't add a column to an already-existing
  // table, so existing databases need an explicit migration. NULL = inherit
  // the global memory setting (see src/app/api/settings/memory/route.ts),
  // same nullable-override semantics as profile_id.
  ensureColumn(instance, 'sessions', 'memory_enabled', 'INTEGER');
  return instance;
}

function ensureColumn(instance: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = instance.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Lazily initializes on first real property access (e.g. the first
// `db.prepare(...)` call from an actual CRUD function below), not on
// module import — see the note above for why that distinction matters.
const db = new Proxy({} as DatabaseSync, {
  get(_target, prop, receiver) {
    if (!realDb) {
      realDb = initDb();
      migrateFromJson(realDb);
    }
    const value = Reflect.get(realDb, prop, receiver);
    return typeof value === 'function' ? value.bind(realDb) : value;
  },
});

// Personas seeded into a genuinely empty database (fresh install/Docker
// volume, nothing to migrate from) so there's something useful to pick from
// on first run instead of an empty list.
const DEFAULT_PERSONAS: Array<{ name: string; prompt: string; tags: string[] }> = [
  {
    name: 'Research Analyst',
    prompt:
      'You are a meticulous research analyst. When asked about current events, prices, statistics, or anything that could have changed since your training, use the web_search tool before answering instead of guessing. Cite the sources you used inline, like (Source: domain.com). Keep answers structured and skimmable: lead with the direct answer, then supporting detail. If search results conflict with each other, say so explicitly rather than silently picking one.',
    tags: ['research', 'web-search'],
  },
  {
    name: 'Code Reviewer',
    prompt:
      'You are a senior software engineer doing a code review. Be direct and specific: point to exact lines, functions, or behaviors, not vague impressions. Prioritize in this order: correctness bugs, then security issues, then unnecessary complexity or duplication. Skip praise and pleasantries. If the code is genuinely fine, say so briefly instead of inventing nitpicks. When you suggest a fix, propose the smallest change that solves the actual problem, not a rewrite.',
    tags: ['coding', 'review'],
  },
  {
    name: 'Creative Writing Partner',
    prompt:
      'You are a creative writing collaborator with a sharp eye for voice and pacing. Match the tone and style the user has already established rather than imposing your own. Favor concrete, sensory detail over abstract description and cliche. When giving feedback, name what is actually working before suggesting changes, and be specific about why something does or does not land. Do not soften honest craft feedback with excessive praise.',
    tags: ['writing', 'creative'],
  },
  {
    name: 'Reiseplaner',
    prompt:
      'Du bist ein lokaler Reiseplaner. Rufe zu Beginn jeder neuen Anfrage IMMER zuerst das get_current_date-Tool auf, um das echte aktuelle Datum zu kennen — rate niemals ein Jahr oder Datum (z.B. keine Formulierungen wie "2025/26", wenn du es nicht abgefragt hast) und nutze das Datum, um saisonale Empfehlungen korrekt einzuordnen (z.B. Weihnachtsmarkt im Dezember, Freiluft-Festivals im Sommer). Wenn der Nutzer einen Ort nennt (Stadt, Region, Land), nutze zusätzlich das web_search-Tool, um aktuelle, konkrete Empfehlungen zu finden — Sehenswürdigkeiten, Restaurants, aktuelle Veranstaltungen, saisonale Besonderheiten, versteckte Geheimtipps. Verlass dich nicht nur auf Trainingswissen, da sich Öffnungszeiten, Events und Bewertungen ändern. Strukturiere die Antwort nach Kategorien (z.B. Sehenswürdigkeiten, Essen & Trinken, Aktuelle Events), nenne konkrete Namen statt vager Kategorien, und gib bei zeitkritischen Infos das Datum der recherchierten Quelle mit an. Frag nach fehlenden wichtigen Präferenzen (Zeitraum, Budget, Interessen wie Kultur/Natur/Nightlife), aber liefere trotzdem sofort eine erste konkrete Auswahl statt nur Rückfragen zu stellen.',
    tags: ['travel', 'web-search'],
  },
];

function seedDefaultLamas(instance: DatabaseSync) {
  const now = Date.now();
  const insert = instance.prepare(
    'INSERT INTO lamas (id, name, prompt, tags, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  DEFAULT_PERSONAS.forEach((p, idx) => {
    insert.run(safeUuid(), p.name, p.prompt, JSON.stringify(p.tags), now + idx);
  });
}

// --- One-time migration from the JSON-file era (safe to re-run: only
// inserts when a table is still empty), falling back to seeding the default
// personas when there's no legacy JSON to migrate from either. Takes the
// raw instance directly (not the lazy `db` proxy) since it's invoked from
// inside that proxy's own initialization step. ---
function migrateFromJson(instance: DatabaseSync) {
  const lamaCount = (instance.prepare('SELECT COUNT(*) as c FROM lamas').get() as { c: number }).c;
  if (lamaCount === 0 && fs.existsSync(lamasJsonFile)) {
    try {
      const rows: LamaRow[] = JSON.parse(fs.readFileSync(lamasJsonFile, 'utf-8'));
      const insert = instance.prepare(
        'INSERT INTO lamas (id, name, prompt, tags, updated_at) VALUES (?, ?, ?, ?, ?)',
      );
      for (const r of rows) insert.run(r.id, r.name, r.prompt, r.tags, r.updated_at);
    } catch {
      /* ignore malformed legacy file */
    }
  } else if (lamaCount === 0) {
    seedDefaultLamas(instance);
  }

  const hostCount = (instance.prepare('SELECT COUNT(*) as c FROM hosts').get() as { c: number }).c;
  if (hostCount === 0 && fs.existsSync(hostsJsonFile)) {
    try {
      const rows: HostRow[] = JSON.parse(fs.readFileSync(hostsJsonFile, 'utf-8'));
      const insert = instance.prepare(
        'INSERT INTO hosts (id, url, label, created_at, last_used_at, active) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const r of rows)
        insert.run(r.id, r.url, r.label ?? null, r.created_at, r.last_used_at, r.active);
    } catch {
      /* ignore */
    }
  }

  const sessionCount = (
    instance.prepare('SELECT COUNT(*) as c FROM sessions').get() as { c: number }
  ).c;
  if (sessionCount === 0 && fs.existsSync(sessionsJsonFile)) {
    try {
      const rows: SessionRow[] = JSON.parse(fs.readFileSync(sessionsJsonFile, 'utf-8'));
      const insert = instance.prepare(
        'INSERT INTO sessions (id, title, title_status, profile_id, model_a, model_b, compare_mode, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const r of rows) {
        insert.run(
          r.id,
          r.title,
          r.titleStatus,
          r.profileId,
          r.modelA,
          r.modelB,
          r.compareMode ? 1 : 0,
          JSON.stringify(r.messages),
          r.created_at,
          r.updated_at,
        );
      }
    } catch {
      /* ignore */
    }
  }
}

// --- Lamas ---

export interface LamaRow {
  id: string;
  name: string;
  prompt: string;
  tags: string; // json array string
  updated_at: number;
}

export function listLamas(): LamaRow[] {
  return db.prepare('SELECT * FROM lamas ORDER BY updated_at DESC').all() as unknown as LamaRow[];
}

export function getLama(id: string): LamaRow | undefined {
  return db.prepare('SELECT * FROM lamas WHERE id = ?').get(id) as LamaRow | undefined;
}

export function createLama(data: {
  id: string;
  name: string;
  prompt?: string;
  tags?: string[];
}): LamaRow {
  const row: LamaRow = {
    id: data.id,
    name: data.name || 'Untitled',
    prompt: data.prompt || '',
    tags: JSON.stringify(data.tags || []),
    updated_at: Date.now(),
  };
  db.prepare('INSERT INTO lamas (id, name, prompt, tags, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    row.id,
    row.name,
    row.prompt,
    row.tags,
    row.updated_at,
  );
  return row;
}

export function updateLama(
  id: string,
  patch: { name?: string; prompt?: string; tags?: string[] },
): LamaRow | undefined {
  const existing = getLama(id);
  if (!existing) return undefined;
  const updated: LamaRow = {
    ...existing,
    name: patch.name ?? existing.name,
    prompt: patch.prompt ?? existing.prompt,
    tags: JSON.stringify(patch.tags ?? JSON.parse(existing.tags)),
    updated_at: Date.now(),
  };
  db.prepare('UPDATE lamas SET name=?, prompt=?, tags=?, updated_at=? WHERE id=?').run(
    updated.name,
    updated.prompt,
    updated.tags,
    updated.updated_at,
    id,
  );
  return updated;
}

export function deleteLama(id: string): void {
  db.prepare('DELETE FROM lamas WHERE id = ?').run(id);
}

export function importLamas(
  list: Array<{ name?: string; prompt?: string; tags?: string[] }>,
): string[] {
  const now = Date.now();
  const ids: string[] = [];
  const insert = db.prepare(
    'INSERT INTO lamas (id, name, prompt, tags, updated_at) VALUES (?, ?, ?, ?, ?)',
  );
  for (const raw of list) {
    const id = safeUuid();
    insert.run(
      id,
      raw.name?.trim() || 'Import',
      raw.prompt || '',
      JSON.stringify((raw.tags || []).slice(0, 20)),
      now,
    );
    ids.push(id);
  }
  return ids;
}

// --- Hosts ---

export interface HostRow {
  id: string;
  url: string;
  label?: string | null;
  created_at: number;
  last_used_at: number;
  active: number; // 0/1
}

export function listHosts(): HostRow[] {
  return db
    .prepare('SELECT * FROM hosts ORDER BY active DESC, last_used_at DESC, created_at DESC')
    .all() as unknown as HostRow[];
}

export function getActiveHost(): HostRow | undefined {
  return db.prepare('SELECT * FROM hosts WHERE active = 1').get() as HostRow | undefined;
}

export function addHost(url: string, label?: string): HostRow {
  const existing = db.prepare('SELECT * FROM hosts WHERE url = ?').get(url) as HostRow | undefined;
  const now = Date.now();
  if (existing) {
    if (label && label !== existing.label) {
      db.prepare('UPDATE hosts SET label=? WHERE id=?').run(label, existing.id);
      return { ...existing, label };
    }
    return existing;
  }
  const row: HostRow = {
    id: safeUuid(),
    url,
    label: label || null,
    created_at: now,
    last_used_at: now,
    active: 0,
  };
  db.prepare(
    'INSERT INTO hosts (id, url, label, created_at, last_used_at, active) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(row.id, row.url, row.label ?? null, row.created_at, row.last_used_at, row.active);
  return row;
}

export function activateHost(id: string): HostRow | undefined {
  const target = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  if (!target) return undefined;
  const now = Date.now();
  db.prepare('UPDATE hosts SET active = 0').run();
  db.prepare('UPDATE hosts SET active = 1, last_used_at = ? WHERE id = ?').run(now, id);
  return db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as unknown as HostRow;
}

export function deleteHost(id: string): void {
  const target = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  if (!target) return;
  db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
  if (target.active) {
    const next = db.prepare('SELECT * FROM hosts ORDER BY last_used_at DESC LIMIT 1').get() as
      HostRow | undefined;
    if (next) {
      db.prepare('UPDATE hosts SET active = 1, last_used_at = ? WHERE id = ?').run(
        Date.now(),
        next.id,
      );
    }
  }
}

export function updateHost(
  id: string,
  patch: { url?: string; label?: string },
): HostRow | undefined {
  const existing = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  if (!existing) return undefined;
  const nextUrl = patch.url?.trim() || existing.url;
  const nextLabel = (patch.label === undefined ? existing.label : patch.label) || null;
  if (nextUrl !== existing.url) {
    const conflict = db.prepare('SELECT id FROM hosts WHERE url = ? AND id != ?').get(nextUrl, id);
    if (conflict) throw new Error('URL already exists');
  }
  db.prepare('UPDATE hosts SET url=?, label=? WHERE id=?').run(nextUrl, nextLabel, id);
  return { ...existing, url: nextUrl, label: nextLabel };
}

// --- Chat Sessions ---

export interface SessionRow {
  id: string;
  title: string;
  titleStatus: 'pending' | 'ready';
  profileId: string | null;
  modelA: string;
  modelB: string;
  compareMode: boolean;
  // Per-session override for the global memory setting. null = inherit the
  // global default (see src/app/api/settings/memory/route.ts); an explicit
  // true/false wins regardless of the global value.
  memoryEnabled: boolean | null;
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
}

interface SessionDbRow {
  id: string;
  title: string;
  title_status: string;
  profile_id: string | null;
  model_a: string;
  model_b: string;
  compare_mode: number;
  memory_enabled: number | null;
  messages: string;
  created_at: number;
  updated_at: number;
}

function rowToSession(r: SessionDbRow): SessionRow {
  return {
    id: r.id,
    title: r.title,
    titleStatus: r.title_status === 'pending' ? 'pending' : 'ready',
    profileId: r.profile_id,
    modelA: r.model_a,
    modelB: r.model_b,
    compareMode: !!r.compare_mode,
    memoryEnabled: r.memory_enabled === null ? null : !!r.memory_enabled,
    messages: JSON.parse(r.messages),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listSessions(): SessionRow[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
  return (rows as unknown as SessionDbRow[]).map(rowToSession);
}

export function getSession(id: string): SessionRow | undefined {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionDbRow | undefined;
  return r ? rowToSession(r) : undefined;
}

export function createSession(data: { profileId?: string | null }): SessionRow {
  const now = Date.now();
  const row: SessionRow = {
    id: safeUuid(),
    title: 'New chat',
    titleStatus: 'pending',
    profileId: data.profileId ?? null,
    modelA: '',
    modelB: '',
    compareMode: false,
    memoryEnabled: null,
    messages: [],
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    'INSERT INTO sessions (id, title, title_status, profile_id, model_a, model_b, compare_mode, memory_enabled, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.title,
    row.titleStatus,
    row.profileId,
    row.modelA,
    row.modelB,
    row.compareMode ? 1 : 0,
    row.memoryEnabled === null ? null : row.memoryEnabled ? 1 : 0,
    JSON.stringify(row.messages),
    row.created_at,
    row.updated_at,
  );
  return row;
}

export function updateSession(
  id: string,
  patch: Partial<
    Pick<
      SessionRow,
      | 'title'
      | 'titleStatus'
      | 'profileId'
      | 'modelA'
      | 'modelB'
      | 'compareMode'
      | 'memoryEnabled'
      | 'messages'
    >
  >,
): SessionRow | undefined {
  const existing = getSession(id);
  if (!existing) return undefined;
  const updated: SessionRow = { ...existing, ...patch, updated_at: Date.now() };
  db.prepare(
    'UPDATE sessions SET title=?, title_status=?, profile_id=?, model_a=?, model_b=?, compare_mode=?, memory_enabled=?, messages=?, updated_at=? WHERE id=?',
  ).run(
    updated.title,
    updated.titleStatus,
    updated.profileId,
    updated.modelA,
    updated.modelB,
    updated.compareMode ? 1 : 0,
    updated.memoryEnabled === null ? null : updated.memoryEnabled ? 1 : 0,
    JSON.stringify(updated.messages),
    updated.updated_at,
    id,
  );
  return updated;
}

export function deleteSession(id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// --- Generic key/value settings (small global config blobs, e.g. tools) ---

export function getSetting<T>(key: string): T | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return undefined;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, JSON.stringify(value));
}

// --- Memories (persistent "the assistant remembers you" facts) ---

export interface MemoryRow {
  id: string;
  content: string;
  sourceSessionId: string | null;
  created_at: number;
}

interface MemoryDbRow {
  id: string;
  content: string;
  source_session_id: string | null;
  created_at: number;
}

function rowToMemory(r: MemoryDbRow): MemoryRow {
  return {
    id: r.id,
    content: r.content,
    sourceSessionId: r.source_session_id,
    created_at: r.created_at,
  };
}

export function listMemories(): MemoryRow[] {
  const rows = db.prepare('SELECT * FROM memories ORDER BY created_at DESC').all();
  return (rows as unknown as MemoryDbRow[]).map(rowToMemory);
}

export function createMemory(data: {
  content: string;
  sourceSessionId?: string | null;
}): MemoryRow {
  const row: MemoryRow = {
    id: safeUuid(),
    content: data.content.trim(),
    sourceSessionId: data.sourceSessionId ?? null,
    created_at: Date.now(),
  };
  db.prepare(
    'INSERT INTO memories (id, content, source_session_id, created_at) VALUES (?, ?, ?, ?)',
  ).run(row.id, row.content, row.sourceSessionId, row.created_at);
  return row;
}

export function deleteMemory(id: string): void {
  db.prepare('DELETE FROM memories WHERE id = ?').run(id);
}

// --- Benchmark runs (per-model speed history, for the /benchmarks page) ---

export interface BenchmarkRunRow {
  id: string;
  model: string;
  source: 'chat' | 'manual';
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSecond: number | null;
  created_at: number;
}

interface BenchmarkRunDbRow {
  id: string;
  model: string;
  source: string;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  tokens_per_second: number | null;
  created_at: number;
}

function rowToBenchmarkRun(r: BenchmarkRunDbRow): BenchmarkRunRow {
  return {
    id: r.id,
    model: r.model,
    source: r.source === 'manual' ? 'manual' : 'chat',
    promptTokens: r.prompt_tokens,
    completionTokens: r.completion_tokens,
    tokensPerSecond: r.tokens_per_second,
    created_at: r.created_at,
  };
}

export function recordBenchmarkRun(data: {
  model: string;
  source: 'chat' | 'manual';
  promptTokens?: number;
  completionTokens?: number;
  tokensPerSecond?: number;
}): void {
  db.prepare(
    'INSERT INTO benchmark_runs (id, model, source, prompt_tokens, completion_tokens, tokens_per_second, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    safeUuid(),
    data.model,
    data.source,
    data.promptTokens ?? null,
    data.completionTokens ?? null,
    data.tokensPerSecond ?? null,
    Date.now(),
  );
}

export function listBenchmarkRuns(opts: { limit?: number } = {}): BenchmarkRunRow[] {
  const limit = opts.limit ?? 500;
  const rows = db
    .prepare('SELECT * FROM benchmark_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit);
  return (rows as unknown as BenchmarkRunDbRow[]).map(rowToBenchmarkRun);
}
