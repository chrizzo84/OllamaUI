// Durable facts the assistant remembers about the user.
import { db } from './connection';
import { safeUuid } from '@/lib/utils';

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
