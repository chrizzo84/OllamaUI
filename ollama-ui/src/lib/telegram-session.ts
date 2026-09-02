/*
The single persistent Telegram conversation.

The bridge keeps one long-lived session so context carries across messages
the way a normal chat does, and /new starts a fresh one. Its id lives in the
`settings` table rather than in a module variable so it survives a restart.

Its own module because both the bridge and the /new command need it, and
neither should have to import the other.
*/
import {
  createSession,
  getSession,
  getSetting,
  setSetting,
  markSessionTelegram,
  updateSession,
} from '@/lib/db';

const SESSION_SETTING_KEY = 'telegram_session_id';

// Starts (or, via /new, restarts) the one persistent Telegram conversation —
// the old session isn't deleted, just abandoned, so it stays visible in the
// web UI's session list if you ever want to look back at it.
export function createNewTelegramSession(): string {
  const row = createSession({ profileId: null, isTelegram: true });
  updateSession(row.id, { title: 'Telegram' });
  setSetting(SESSION_SETTING_KEY, row.id);
  return row.id;
}

export function getOrCreateSessionId(): string {
  const existingId = getSetting<string>(SESSION_SETTING_KEY);
  const existing = existingId ? getSession(existingId) : undefined;
  if (existing) {
    // Backfills a session created before the is_telegram column existed
    // (e.g. an already-running conversation from before this feature
    // shipped) — a no-op once it's already flagged.
    if (!existing.isTelegram) markSessionTelegram(existing.id);
    return existing.id;
  }
  return createNewTelegramSession();
}
