// Persona/profile rows (the 'Lamas' page).
import { db } from './connection';
import { safeUuid } from '@/lib/utils';

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
