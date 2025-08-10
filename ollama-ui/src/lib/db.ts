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
  }
  return db;
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
