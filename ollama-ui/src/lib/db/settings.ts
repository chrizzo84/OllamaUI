// Generic key/value settings blobs.
import { db } from './connection';

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
