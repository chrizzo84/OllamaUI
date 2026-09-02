// Configured Ollama hosts and which one is active.
import { db } from './connection';
import { safeUuid } from '@/lib/utils';

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
