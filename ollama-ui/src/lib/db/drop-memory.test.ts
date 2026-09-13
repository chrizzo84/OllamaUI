import { describe, it, expect, afterAll } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
Opening a database written by a version that still had the memory system.

The removal drops six tables and two columns on first open, which is the one
moment this codebase can make a database unopenable for good. So the test is
not "are the tables gone" alone — it is that everything else survives the
drop and the app still works on the result.
*/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-ui-drop-memory-'));
const dbPath = path.join(tmpDir, 'app.db');

// A database shaped like the old one, written before the app ever sees it.
const legacy = new DatabaseSync(dbPath);
legacy.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT, title_status TEXT, profile_id TEXT,
    model_a TEXT, model_b TEXT, compare_mode INTEGER NOT NULL DEFAULT 0,
    memory_enabled INTEGER, is_telegram INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, source_session_id TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE entities (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE memory_edges (id TEXT PRIMARY KEY, from_id TEXT NOT NULL);
  CREATE TABLE memory_scans (message_id TEXT PRIMARY KEY, scanned_at INTEGER NOT NULL, found INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE memory_maintenance_runs (id TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
  CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid');
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
`);
legacy
  .prepare(
    'INSERT INTO sessions (id, title, memory_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
  .run('old-session', 'Ein früheres Gespräch', 1, Date.now(), Date.now());
legacy
  .prepare('INSERT INTO memories (id, content, created_at) VALUES (?, ?, ?)')
  .run('m1', 'irgendein Fakt', Date.now());
legacy.close();

process.env.OLLAMA_UI_DATA_DIR = tmpDir;
const db = await import('../db');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('opening a database that still has the memory system', () => {
  const tables = () =>
    (
      db
        .dbInstance()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as {
        name: string;
      }[]
    ).map((r) => r.name);

  it('drops every table it left behind', () => {
    const names = tables();
    for (const gone of [
      'memories',
      'memories_fts',
      'entities',
      'memory_edges',
      'memory_scans',
      'memory_maintenance_runs',
    ]) {
      expect(names).not.toContain(gone);
    }
  });

  it('drops the per-chat switch column', () => {
    const columns = (
      db.dbInstance().prepare('PRAGMA table_info(sessions)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(columns).not.toContain('memory_enabled');
  });

  // The whole point of dropping rather than ignoring: what someone came for
  // is their conversations, and they have to come through untouched.
  it('keeps the conversations that were already there', () => {
    expect(db.listSessions().map((s) => s.id)).toContain('old-session');
    expect(db.getSession('old-session')?.title).toBe('Ein früheres Gespräch');
  });

  it('leaves a working database behind', () => {
    const session = db.createSession({});
    db.upsertMessages(session.id, [
      { id: 'm-new', role: 'user', content: 'hallo', createdAt: Date.now() },
    ]);
    expect(db.listMessages(session.id)).toHaveLength(1);
    for (const kept of ['messages', 'sessions', 'settings', 'hosts', 'scheduled_tasks']) {
      expect(tables()).toContain(kept);
    }
  });
});
