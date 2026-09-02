import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupBeforeMigration, backupPeriodically, listBackups, backupsDisabled } from './backup';

/*
Runs against a real SQLite file: the thing worth testing is that VACUUM INTO
produces an openable database with the rows actually in it, which a mock
would assert nothing about.
*/
let dir: string;
let db: DatabaseSync;

beforeEach(() => {
  vi.unstubAllEnvs();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-ui-backup-test-'));
  db = new DatabaseSync(path.join(dir, 'app.db'));
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.exec("INSERT INTO notes (body) VALUES ('first'), ('second')");
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const backupsIn = () => listBackups(dir);

describe('backupBeforeMigration', () => {
  it('writes a snapshot that actually contains the data', () => {
    const file = backupBeforeMigration(db, dir, 'pre-test')!;
    const restored = new DatabaseSync(file, { readOnly: true });
    const rows = restored.prepare('SELECT body FROM notes ORDER BY id').all();
    restored.close();
    expect(rows).toEqual([{ body: 'first' }, { body: 'second' }]);
  });

  it('names the file after the reason, so a pre-migration snapshot is identifiable', () => {
    const file = backupBeforeMigration(db, dir, 'pre-messages-migration')!;
    expect(path.basename(file)).toMatch(/^app-.*-pre-messages-migration\.db$/);
  });

  it('captures writes still sitting in the write-ahead log', () => {
    // A plain file copy can miss these; VACUUM INTO does not.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec("INSERT INTO notes (body) VALUES ('in-wal')");
    const file = backupBeforeMigration(db, dir, 'pre-test')!;
    const restored = new DatabaseSync(file, { readOnly: true });
    const count = restored.prepare('SELECT COUNT(*) AS c FROM notes').get() as { c: number };
    restored.close();
    expect(count.c).toBe(3);
  });

  it('throws rather than letting a one-way migration run unprotected', () => {
    // An unwritable backup directory is the realistic failure (full disk,
    // read-only volume). Aborting leaves the database untouched.
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.chmodSync(path.join(dir, 'backups'), 0o500);
    try {
      expect(() => backupBeforeMigration(db, dir, 'pre-test')).toThrow(/Refusing to run/);
    } finally {
      fs.chmodSync(path.join(dir, 'backups'), 0o700);
    }
  });

  it('explains how to proceed anyway in the failure message', () => {
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.chmodSync(path.join(dir, 'backups'), 0o500);
    try {
      expect(() => backupBeforeMigration(db, dir, 'pre-test')).toThrow(
        /OLLAMA_UI_BACKUP_DISABLED=1/,
      );
    } finally {
      fs.chmodSync(path.join(dir, 'backups'), 0o700);
    }
  });

  it('proceeds without a snapshot when backups are explicitly disabled', () => {
    vi.stubEnv('OLLAMA_UI_BACKUP_DISABLED', '1');
    expect(backupBeforeMigration(db, dir, 'pre-test')).toBeNull();
    expect(backupsIn()).toHaveLength(0);
  });
});

describe('backupPeriodically', () => {
  it('takes one on a fresh install', () => {
    backupPeriodically(db, dir);
    expect(backupsIn()).toHaveLength(1);
    expect(path.basename(backupsIn()[0].file)).toMatch(/-daily\.db$/);
  });

  it('does not take another one straight away', () => {
    // Otherwise every restart — including a container crash loop — would take
    // one, and the retained set would all be from the same minute.
    backupPeriodically(db, dir);
    backupPeriodically(db, dir);
    backupPeriodically(db, dir);
    expect(backupsIn()).toHaveLength(1);
  });

  it('takes another once the newest is a day old', () => {
    backupPeriodically(db, dir);
    const old = backupsIn()[0].file;
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
    backupPeriodically(db, dir);
    expect(backupsIn()).toHaveLength(2);
  });

  it('does nothing when disabled', () => {
    vi.stubEnv('OLLAMA_UI_BACKUP_DISABLED', '1');
    backupPeriodically(db, dir);
    expect(backupsIn()).toHaveLength(0);
  });

  it('never throws — a failed routine backup must not stop the app starting', () => {
    fs.mkdirSync(path.join(dir, 'backups'));
    fs.chmodSync(path.join(dir, 'backups'), 0o500);
    try {
      expect(() => backupPeriodically(db, dir)).not.toThrow();
    } finally {
      fs.chmodSync(path.join(dir, 'backups'), 0o700);
    }
  });
});

describe('retention', () => {
  // Snapshots are named to the second, so distinct timestamps are forced by
  // ageing each one before taking the next.
  function makeBackups(n: number) {
    for (let i = 0; i < n; i++) {
      backupBeforeMigration(db, dir, `run${i}`);
      for (const b of backupsIn()) {
        const t = new Date(b.createdAt - 60_000);
        fs.utimesSync(b.file, t, t);
      }
    }
  }

  it('keeps the newest 7 by default', () => {
    vi.stubEnv('OLLAMA_UI_BACKUP_KEEP', '');
    makeBackups(10);
    expect(backupsIn()).toHaveLength(7);
  });

  it('honours OLLAMA_UI_BACKUP_KEEP', () => {
    vi.stubEnv('OLLAMA_UI_BACKUP_KEEP', '2');
    makeBackups(5);
    expect(backupsIn()).toHaveLength(2);
  });

  it('deletes the oldest, not the newest', () => {
    vi.stubEnv('OLLAMA_UI_BACKUP_KEEP', '2');
    makeBackups(4);
    const remaining = backupsIn();
    // run3 was taken last, so it must survive; run0 must not.
    expect(remaining.some((b) => b.file.includes('run3'))).toBe(true);
    expect(remaining.some((b) => b.file.includes('run0'))).toBe(false);
  });

  it('falls back to the default for a nonsense retention value', () => {
    vi.stubEnv('OLLAMA_UI_BACKUP_KEEP', 'not-a-number');
    makeBackups(9);
    expect(backupsIn()).toHaveLength(7);
  });
});

describe('listBackups', () => {
  it('is empty before anything has been backed up', () => {
    expect(backupsIn()).toEqual([]);
  });

  it('ignores files that are not snapshots', () => {
    fs.mkdirSync(path.join(dir, 'backups'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'backups', 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'backups', 'app.db'), 'x');
    expect(backupsIn()).toEqual([]);
  });

  it('returns newest first, with sizes', () => {
    backupBeforeMigration(db, dir, 'older');
    const first = backupsIn()[0];
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(first.file, past, past);
    backupBeforeMigration(db, dir, 'newer');
    const all = backupsIn();
    expect(all[0].file).toContain('newer');
    expect(all[0].byteSize).toBeGreaterThan(0);
  });
});

describe('backupsDisabled', () => {
  it('is off by default', () => {
    expect(backupsDisabled()).toBe(false);
  });

  it('only responds to exactly "1"', () => {
    vi.stubEnv('OLLAMA_UI_BACKUP_DISABLED', 'true');
    expect(backupsDisabled()).toBe(false);
    vi.stubEnv('OLLAMA_UI_BACKUP_DISABLED', '1');
    expect(backupsDisabled()).toBe(true);
  });
});
