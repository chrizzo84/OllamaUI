// Chat session metadata. The messages themselves are in messages.ts.
import { db } from './connection';
import { safeUuid } from '@/lib/utils';

// --- Chat Sessions ---

/*
Session metadata only. The messages themselves live in their own table and
are fetched with listMessages(); loading a sidebar of 200 sessions must not
mean deserializing 200 conversations.
*/
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
  // True only for the single, persistent Telegram bridge conversation (see
  // createNewTelegramSession in telegram-bridge.ts) — lets the web UI mark
  // it visually so it's not mistaken for an ordinary web chat. Fixed at
  // creation, never patched afterwards.
  isTelegram: boolean;
  // Active leaf of each column's message tree; null = that column is empty.
  headA: string | null;
  headB: string | null;
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
  is_telegram: number;
  head_a: string | null;
  head_b: string | null;
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
    isTelegram: !!r.is_telegram,
    headA: r.head_a,
    headB: r.head_b,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function listSessions(): SessionRow[] {
  const rows = db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all();
  return (rows as unknown as SessionDbRow[]).map(rowToSession);
}

// Message counts for many sessions in one query — what the sidebar needs,
// without reading a single message body.
export function messageCountsBySession(): Map<string, number> {
  const rows = db
    .prepare('SELECT session_id, COUNT(*) AS c FROM messages GROUP BY session_id')
    .all() as unknown as Array<{ session_id: string; c: number }>;
  return new Map(rows.map((r) => [r.session_id, r.c]));
}

export function getSession(id: string): SessionRow | undefined {
  const r = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionDbRow | undefined;
  return r ? rowToSession(r) : undefined;
}

export function createSession(data: {
  profileId?: string | null;
  isTelegram?: boolean;
}): SessionRow {
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
    isTelegram: data.isTelegram ?? false,
    headA: null,
    headB: null,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    'INSERT INTO sessions (id, title, title_status, profile_id, model_a, model_b, compare_mode, memory_enabled, is_telegram, head_a, head_b, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    row.id,
    row.title,
    row.titleStatus,
    row.profileId,
    row.modelA,
    row.modelB,
    row.compareMode ? 1 : 0,
    row.memoryEnabled === null ? null : row.memoryEnabled ? 1 : 0,
    row.isTelegram ? 1 : 0,
    row.headA,
    row.headB,
    row.created_at,
    row.updated_at,
  );
  return row;
}

// One-time backfill for a Telegram session created before the is_telegram
// column existed (e.g. the single long-running conversation from before
// this feature shipped) — updateSession's Pick<> deliberately excludes
// isTelegram since it's meant to be set once at creation, so this bypasses
// that for the migration case specifically. Idempotent; callers only need
// to invoke it when they already know the flag is unset (see
// getOrCreateSessionId in telegram-bridge.ts).
export function markSessionTelegram(id: string): void {
  db.prepare('UPDATE sessions SET is_telegram = 1 WHERE id = ?').run(id);
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
      | 'headA'
      | 'headB'
    >
  >,
): SessionRow | undefined {
  const existing = getSession(id);
  if (!existing) return undefined;
  const updated: SessionRow = { ...existing, ...patch, updated_at: Date.now() };
  db.prepare(
    'UPDATE sessions SET title=?, title_status=?, profile_id=?, model_a=?, model_b=?, compare_mode=?, memory_enabled=?, head_a=?, head_b=?, updated_at=? WHERE id=?',
  ).run(
    updated.title,
    updated.titleStatus,
    updated.profileId,
    updated.modelA,
    updated.modelB,
    updated.compareMode ? 1 : 0,
    updated.memoryEnabled === null ? null : updated.memoryEnabled ? 1 : 0,
    updated.headA,
    updated.headB,
    updated.updated_at,
    id,
  );
  return updated;
}

export function deleteSession(id: string): void {
  // Explicit rather than relying on ON DELETE CASCADE: foreign key
  // enforcement is off by default in SQLite and this must not depend on a
  // pragma being set somewhere else.
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}
