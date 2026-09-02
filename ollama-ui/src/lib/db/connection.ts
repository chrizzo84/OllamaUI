/**
 * Database connection, schema and migrations — the single place the SQLite
 * file is opened and kept up to date.
 *
 * The per-entity queries live in siblings of this file (sessions.ts,
 * messages.ts, evals.ts, ...) and all import the same lazy `db` handle from
 * here. src/lib/db.ts re-exports the whole set, so callers still write
 * `from '@/lib/db'` and never need to know which module a function is in.
 *
 * This used to be one file holding schema, migrations and the CRUD for nine
 * entities. It stayed readable at ~900 lines and stopped being so at ~2000,
 * which is where per-message storage, attachments, full-text search and
 * evaluation runs took it.
 */
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
import type { LamaRow } from './lamas';
import type { HostRow } from './hosts';
import type { SessionRow } from './sessions';
import type { ChatMessage } from '@/store/chat';
import path from 'path';
import fs from 'fs';
import { createHash } from 'node:crypto';
import { backupBeforeMigration, backupPeriodically } from './backup';

/*
Where the database and uploaded files live. Defaults to ./data next to the
running app, which is what the Docker image mounts as a volume;
OLLAMA_UI_DATA_DIR moves it somewhere else, which also lets the tests point
at a throwaway directory instead of the real one.
*/
export const dataDir = process.env.OLLAMA_UI_DATA_DIR
  ? path.resolve(process.env.OLLAMA_UI_DATA_DIR)
  : path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'app.db');
const lamasJsonFile = path.join(dataDir, 'lamas.json');
const hostsJsonFile = path.join(dataDir, 'hosts.json');
const sessionsJsonFile = path.join(dataDir, 'sessions.json');
export const uploadsDir = path.join(dataDir, 'uploads');

/*
Attachment bytes live on disk, keyed by the SHA-256 of their content, with
only the metadata row in SQLite. Content addressing means the same image
attached to five messages is stored once and needs no reference counting to
stay correct — the file is valid as long as any message points at it.

Takes the raw DatabaseSync rather than the lazy `db` proxy so the
migrations, which run inside that proxy's own initialization, can call it.
*/
export function writeAttachment(
  instance: DatabaseSync,
  bytes: Buffer,
  mime: string,
): { id: string; bytes: number } {
  const id = createHash('sha256').update(bytes).digest('hex');
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
  const file = path.join(uploadsDir, id);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  instance
    .prepare(
      'INSERT OR IGNORE INTO attachments (id, mime, byte_size, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(id, mime, bytes.length, Date.now());
  return { id, bytes: bytes.length };
}

// Migration helper: takes the raw base64 that used to sit inline in a
// message and turns it into a stored attachment. Returns null (rather than
// throwing) for unreadable data so one corrupt image can't abort a
// migration covering every conversation.
function writeAttachmentFromBase64(instance: DatabaseSync, b64: string): string | null {
  try {
    const bytes = Buffer.from(b64, 'base64');
    if (!bytes.length) return null;
    return writeAttachment(instance, bytes, sniffImageMime(bytes)).id;
  } catch {
    return null;
  }
}

// Enough of a magic-number check to label the bytes we actually produce.
// The old inline-base64 path assumed image/png for everything, which broke
// nothing but mislabelled every JPEG.
export function sniffImageMime(bytes: Buffer): string {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii').startsWith('GIF8'))
    return 'image/gif';
  return 'application/octet-stream';
}

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
      is_telegram INTEGER NOT NULL DEFAULT 0,
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
    /*
    One row per chat message. Messages used to live as a single JSON blob in
    sessions.messages, which meant every appended token's worth of state
    rewrote the entire conversation, listSessions() deserialized every
    message of every session just to show a sidebar, and search had to scan
    all of it in memory. It also made attachments (base64 image data) part
    of that blob, so a handful of screenshots bloated every read of the
    session.

    parent_id makes the history a tree rather than a list: regenerating or
    editing adds a sibling instead of destroying what was there (see
    listMessages/setSessionHead below). A conversation with no branches is
    just a tree where every node has one child, so the linear case is
    unchanged.
    */
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_id TEXT,
      column_key TEXT NOT NULL DEFAULT 'A',
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      model TEXT,
      raw TEXT,
      trace TEXT,
      stats TEXT,
      attachments TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, column_key, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);

    /*
    Full-text index over message content, kept in sync by the triggers
    below. content='messages' makes it an external-content index: the text
    is not stored twice, the FTS table only holds the inverted index and
    reads the original rows from messages when it needs them.
    */
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content='messages',
      content_rowid='rowid',
      tokenize='unicode61 remove_diacritics 2'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    /*
    Uploaded files (images a vision model reads, documents fed in as
    context), addressed by the SHA-256 of their bytes so sending the same
    screenshot twice stores it once. The bytes themselves live on disk under
    data/uploads/ rather than in SQLite: they are written once and read
    whole, which is what a filesystem is for, and it keeps the database
    small enough to stay fast and easy to back up.
    */
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    /*
    Evaluation sets: a saved list of prompts, run against several models so
    their answers can be read side by side and scored.

    The existing benchmark measures tokens/second on one fixed prompt, which
    answers "which model is fastest" — but the question you actually have
    when choosing a local model is "which one is better at MY kind of work",
    and that needs your own prompts and your own judgement. Speed is already
    recorded per result here too, so the trade-off is visible in one place.
    */
    CREATE TABLE IF NOT EXISTS eval_sets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompts TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS eval_runs (
      id TEXT PRIMARY KEY,
      set_id TEXT NOT NULL,
      set_name TEXT NOT NULL,
      models TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL,
      finished_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS eval_results (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      prompt_index INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      error TEXT,
      tokens_per_second REAL,
      duration_ms INTEGER,
      -- NULL until a human scores it: an unrated answer and a bad one are
      -- very different things and must not look the same.
      rating INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results(run_id, prompt_index);
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      model TEXT NOT NULL,
      time_of_day TEXT NOT NULL,
      days_of_week TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
      recurring INTEGER NOT NULL DEFAULT 1,
      tools_enabled INTEGER NOT NULL DEFAULT 1,
      memory_enabled INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      next_run_at INTEGER,
      last_run_at INTEGER,
      last_run_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  // `sessions` predates the per-session memory override — a plain `CREATE
  // TABLE IF NOT EXISTS` above won't add a column to an already-existing
  // table, so existing databases need an explicit migration. NULL = inherit
  // the global memory setting (see src/app/api/settings/memory/route.ts),
  // same nullable-override semantics as profile_id.
  ensureColumn(instance, 'sessions', 'memory_enabled', 'INTEGER');
  // `sessions` also predates the Telegram bridge — its one persistent
  // conversation is flagged so the web UI can mark it visually (see
  // app-sidebar.tsx). Set once at creation (createNewTelegramSession in
  // telegram-bridge.ts), never toggled afterwards.
  ensureColumn(instance, 'sessions', 'is_telegram', 'INTEGER NOT NULL DEFAULT 0');
  // `scheduled_tasks` predates one-off reminders (the create_reminder tool,
  // see generation-runner.ts) — existing recurring tasks default to
  // recurring=1 via DEFAULT 1 in ALTER TABLE, so they keep behaving exactly
  // as before this column existed.
  ensureColumn(instance, 'scheduled_tasks', 'recurring', 'INTEGER NOT NULL DEFAULT 1');
  // The active leaf of each column's message tree — what the conversation
  // currently shows. NULL means "empty column". See listMessages().
  ensureColumn(instance, 'sessions', 'head_a', 'TEXT');
  ensureColumn(instance, 'sessions', 'head_b', 'TEXT');
  migrateMessagesOutOfSessionBlob(instance);
  /*
  Routine snapshot, after the schema is settled so what's captured is always
  a database this version of the app can open. At most one per day, and never
  fatal — see src/lib/db/backup.ts.
  */
  backupPeriodically(instance, dataDir);
  return instance;
}

/*
Moves the pre-existing sessions.messages JSON blob into the `messages`
table, once, then drops the column so there is exactly one source of truth
afterwards. Runs inside a transaction: a half-migrated database (some
sessions moved, the blob column already gone) would silently lose history,
so it either completes or leaves everything as it was.

Base64 image data embedded in those old messages is written out to
data/uploads/ as it goes, which is usually where most of the blob's size
was.
*/
function migrateMessagesOutOfSessionBlob(instance: DatabaseSync): void {
  const cols = instance.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'messages')) return; // already migrated

  /*
  Snapshot first, and refuse to continue if one can't be written. The column
  drop below is the one step in this codebase that cannot be undone, so the
  backup is a precondition of running it rather than a nice-to-have.
  Aborting here leaves the database exactly as it was and the migration still
  pending, so it runs on the next start once the problem is fixed.
  */
  backupBeforeMigration(instance, dataDir, 'pre-messages-migration');

  const rows = instance.prepare('SELECT id, messages FROM sessions').all() as Array<{
    id: string;
    messages: string;
  }>;

  instance.exec('BEGIN');
  try {
    const insert = instance.prepare(
      `INSERT OR REPLACE INTO messages
         (id, session_id, parent_id, column_key, role, content, model, raw, trace, stats, attachments, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of rows) {
      let parsed: ChatMessage[];
      try {
        parsed = JSON.parse(row.messages || '[]');
      } catch {
        continue; // unreadable blob: nothing to salvage, don't abort the rest
      }
      if (!Array.isArray(parsed)) continue;

      // Parent chains are per column, since compare mode runs two
      // independent threads inside one session.
      const lastByColumn: Record<string, string | null> = { A: null, B: null };
      for (const [idx, m] of parsed.entries()) {
        if (!m?.id) continue;
        const column = m.column === 'B' ? 'B' : 'A';
        const attachmentIds = (m.images ?? [])
          .map((b64) => writeAttachmentFromBase64(instance, b64))
          .filter((x): x is string => !!x);
        insert.run(
          m.id,
          row.id,
          lastByColumn[column],
          column,
          m.role,
          m.content ?? '',
          m.model ?? null,
          m.raw ?? null,
          m.trace ? JSON.stringify(m.trace) : null,
          m.stats ? JSON.stringify(m.stats) : null,
          JSON.stringify(attachmentIds),
          m.createdAt ?? Date.now() + idx,
        );
        lastByColumn[column] = m.id;
      }
      instance
        .prepare('UPDATE sessions SET head_a = ?, head_b = ? WHERE id = ?')
        .run(lastByColumn.A, lastByColumn.B, row.id);
    }
    instance.exec('ALTER TABLE sessions DROP COLUMN messages');
    instance.exec('COMMIT');
  } catch (e) {
    instance.exec('ROLLBACK');
    throw e;
  }
  /*
  Dropping the column and deleting the blobs only marks those pages free;
  the file keeps its old size until it is rebuilt. On a database whose bulk
  was inlined base64 images that is most of the file, so it is worth the
  one-off cost — this runs exactly once, on the first start after the
  upgrade. VACUUM cannot run inside a transaction, hence its position after
  the COMMIT. A failure here is cosmetic (wasted disk, correct data), so it
  must not take the app down with it.
  */
  try {
    instance.exec('VACUUM');
  } catch {
    /* ignore — the migration itself already succeeded */
  }
}

function ensureColumn(instance: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = instance.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  instance.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

// Lazily initializes on first real property access (e.g. the first
// `db.prepare(...)` call from an actual CRUD function below), not on
// module import — see the note above for why that distinction matters.
// Forces initialization and hands back the raw connection, for the few
// helpers (attachment writes) that were written against DatabaseSync
// directly so the migrations could reuse them.
export function dbInstance(): DatabaseSync {
  db.prepare('SELECT 1').get();
  return realDb!;
}

export const db = new Proxy({} as DatabaseSync, {
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
      const rows: Array<SessionRow & { messages?: ChatMessage[] }> = JSON.parse(
        fs.readFileSync(sessionsJsonFile, 'utf-8'),
      );
      const insert = instance.prepare(
        'INSERT INTO sessions (id, title, title_status, profile_id, model_a, model_b, compare_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      const insertMessage = instance.prepare(
        `INSERT OR REPLACE INTO messages
           (id, session_id, parent_id, column_key, role, content, model, raw, trace, stats, attachments, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          r.created_at,
          r.updated_at,
        );
        // Same per-column parent chaining as the blob migration above.
        const lastByColumn: Record<string, string | null> = { A: null, B: null };
        for (const [idx, m] of (r.messages ?? []).entries()) {
          if (!m?.id) continue;
          const column = m.column === 'B' ? 'B' : 'A';
          const attachmentIds = (m.images ?? [])
            .map((b64) => writeAttachmentFromBase64(instance, b64))
            .filter((x): x is string => !!x);
          insertMessage.run(
            m.id,
            r.id,
            lastByColumn[column],
            column,
            m.role,
            m.content ?? '',
            m.model ?? null,
            m.raw ?? null,
            m.trace ? JSON.stringify(m.trace) : null,
            m.stats ? JSON.stringify(m.stats) : null,
            JSON.stringify(attachmentIds),
            m.createdAt ?? Date.now() + idx,
          );
          lastByColumn[column] = m.id;
        }
        instance
          .prepare('UPDATE sessions SET head_a = ?, head_b = ? WHERE id = ?')
          .run(lastByColumn.A, lastByColumn.B, r.id);
      }
    } catch {
      /* ignore */
    }
  }
}
