import Database from 'better-sqlite3';
import { safeUuid } from '@/lib/utils';
import path from 'path';
import fs from 'fs';

const dbFile = path.join(process.cwd(), 'data', 'app.db');
const dir = path.dirname(dbFile);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

// singleton
let db: Database.Database | null = null;

export function getDb() {
  if (!db) {
    db = new Database(dbFile);
    db.pragma('journal_mode = WAL');
    // init
    db.exec(`CREATE TABLE IF NOT EXISTS lamas (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS hosts (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      label TEXT,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 0
    );`);
    db.exec(`CREATE TABLE IF NOT EXISTS prefs (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );`);
  }
  return db;
}

// ---- Prefs Management ----
export function getPref(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM prefs WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setPref(key: string, value: string) {
  getDb().prepare('INSERT OR REPLACE INTO prefs (key, value) VALUES (?, ?)').run(key, value);
}

export interface LamaRow {
  id: string;
  name: string;
  prompt: string;
  tags: string; // json array
  updated_at: number;
}

export function listLamas(): LamaRow[] {
  return getDb().prepare('SELECT * FROM lamas ORDER BY updated_at DESC').all() as LamaRow[];
}

export function getLama(id: string): LamaRow | undefined {
  return getDb().prepare('SELECT * FROM lamas WHERE id = ?').get(id) as LamaRow | undefined;
}

export function createLama(data: { id: string; name: string; prompt?: string; tags?: string[] }) {
  const now = Date.now();
  getDb()
    .prepare(
      'INSERT INTO lamas (id, name, prompt, tags, updated_at) VALUES (@id, @name, @prompt, @tags, @updated_at)',
    )
    .run({
      id: data.id,
      name: data.name || 'Untitled',
      prompt: data.prompt || '',
      tags: JSON.stringify(data.tags || []),
      updated_at: now,
    });
  return getLama(data.id)!;
}

export function updateLama(id: string, patch: { name?: string; prompt?: string; tags?: string[] }) {
  const existing = getLama(id);
  if (!existing) return undefined;
  const now = Date.now();
  const name = patch.name ?? existing.name;
  const prompt = patch.prompt ?? existing.prompt;
  const tags = JSON.stringify(patch.tags ?? JSON.parse(existing.tags));
  getDb()
    .prepare(
      'UPDATE lamas SET name=@name, prompt=@prompt, tags=@tags, updated_at=@updated_at WHERE id=@id',
    )
    .run({ id, name, prompt, tags, updated_at: now });
  return getLama(id)!;
}

export function deleteLama(id: string) {
  getDb().prepare('DELETE FROM lamas WHERE id = ?').run(id);
}

export function importLamas(list: Array<{ name?: string; prompt?: string; tags?: string[] }>) {
  const results: string[] = [];
  const insert = getDb().prepare(
    'INSERT INTO lamas (id, name, prompt, tags, updated_at) VALUES (@id, @name, @prompt, @tags, @updated_at)',
  );
  const now = Date.now();
  const tx = getDb().transaction((items: typeof list) => {
    for (const raw of items) {
      const id = safeUuid();
      insert.run({
        id,
        name: raw.name?.trim() || 'Import',
        prompt: raw.prompt || '',
        tags: JSON.stringify((raw.tags || []).slice(0, 20)),
        updated_at: now,
      });
      results.push(id);
    }
  });
  tx(list);
  return results;
}

// ---- Ollama Hosts Management ----
export interface HostRow {
  id: string;
  url: string;
  label?: string | null;
  created_at: number;
  last_used_at: number;
  active: number; // 0/1
}

export function listHosts(): HostRow[] {
  return getDb()
    .prepare('SELECT * FROM hosts ORDER BY active DESC, last_used_at DESC, created_at DESC')
    .all() as HostRow[];
}

export function getActiveHost(): HostRow | undefined {
  return getDb().prepare('SELECT * FROM hosts WHERE active = 1 LIMIT 1').get() as
    | HostRow
    | undefined;
}

export function addHost(url: string, label?: string): HostRow {
  const existing = getDb().prepare('SELECT * FROM hosts WHERE url = ?').get(url) as
    | HostRow
    | undefined;
  const now = Date.now();
  if (existing) {
    // Optionally update label
    if (label && label !== existing.label) {
      getDb().prepare('UPDATE hosts SET label=@label WHERE id=@id').run({ id: existing.id, label });
    }
    return existing;
  }
  const id = safeUuid();
  getDb()
    .prepare(
      'INSERT INTO hosts (id, url, label, created_at, last_used_at, active) VALUES (@id, @url, @label, @created_at, @last_used_at, 0)',
    )
    .run({ id, url, label: label || null, created_at: now, last_used_at: now });
  return getDb().prepare('SELECT * FROM hosts WHERE id=?').get(id) as HostRow;
}

export function activateHost(id: string): HostRow | undefined {
  const dbi = getDb();
  const existing = dbi.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  if (!existing) return undefined;
  const now = Date.now();
  const tx = dbi.transaction(() => {
    dbi.prepare('UPDATE hosts SET active = 0').run();
    dbi.prepare('UPDATE hosts SET active = 1, last_used_at = @now WHERE id = @id').run({ id, now });
  });
  tx();
  return dbi.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow;
}

export function deleteHost(id: string) {
  const dbi = getDb();
  const row = dbi.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  if (!row) return;
  dbi.prepare('DELETE FROM hosts WHERE id = ?').run(id);
  // If it was active, try to promote most recent remaining
  if (row.active) {
    const next = dbi
      .prepare('SELECT id FROM hosts ORDER BY last_used_at DESC, created_at DESC LIMIT 1')
      .get() as { id: string } | undefined;
    if (next) activateHost(next.id);
  }
}

export function updateHost(
  id: string,
  patch: { url?: string; label?: string },
): HostRow | undefined {
  const dbi = getDb();
  const existing = dbi.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow | undefined;
  if (!existing) return undefined;
  const nextUrl = patch.url?.trim() || existing.url;
  const nextLabel = (patch.label === undefined ? existing.label : patch.label) || null;
  if (nextUrl !== existing.url) {
    const conflict = dbi
      .prepare('SELECT id FROM hosts WHERE url = ? AND id != ?')
      .get(nextUrl, id) as { id: string } | undefined;
    if (conflict) {
      throw new Error('URL already exists');
    }
  }
  dbi
    .prepare('UPDATE hosts SET url=@url, label=@label WHERE id=@id')
    .run({ id, url: nextUrl, label: nextLabel });
  return dbi.prepare('SELECT * FROM hosts WHERE id = ?').get(id) as HostRow;
}
