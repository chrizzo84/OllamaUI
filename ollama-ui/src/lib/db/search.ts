// Full-text search across messages and session titles.
import { db } from './connection';

// --- Search ---

export interface MessageSearchHit {
  sessionId: string;
  title: string;
  messageId: string;
  snippet: string;
  matchField: 'title' | 'message';
  updatedAt: number;
}

/*
Escapes a user's query for FTS5's MATCH grammar. Everything is wrapped as a
quoted phrase (with embedded quotes doubled), so characters that are
operators to FTS5 — AND/OR/NOT, NEAR, *, ^, :, parentheses — are searched
for literally instead of either changing the meaning of the query or, for
unbalanced ones, throwing a syntax error out of what the user experiences as
"typing in a search box".
*/
function toMatchQuery(raw: string): string | null {
  const terms = raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => '"' + t.replace(/"/g, '""') + '"');
  if (terms.length === 0) return null;
  // Trailing * on the last term makes it prefix-matching, so results appear
  // while still typing a word.
  terms[terms.length - 1] = terms[terms.length - 1] + ' *';
  return terms.join(' AND ');
}

/*
Full-text search across every message, plus a plain substring match on
session titles (too few of those to be worth indexing).

This replaces loading every session and scanning it in memory. The index
does the work in SQLite, so cost scales with the number of *matches*, not
with the size of the history.
*/
export function searchMessages(query: string, limit = 50): MessageSearchHit[] {
  const match = toMatchQuery(query);
  if (!match) return [];

  const hits: MessageSearchHit[] = [];
  const seenSessions = new Set<string>();

  const titleRows = db
    .prepare(
      "SELECT id, title, updated_at FROM sessions WHERE title LIKE '%' || ? || '%' ORDER BY updated_at DESC LIMIT ?",
    )
    .all(query, limit) as unknown as Array<{ id: string; title: string; updated_at: number }>;
  for (const r of titleRows) {
    hits.push({
      sessionId: r.id,
      title: r.title,
      messageId: '',
      snippet: r.title,
      matchField: 'title',
      updatedAt: r.updated_at,
    });
    seenSessions.add(r.id);
  }

  let rows: Array<{
    id: string;
    session_id: string;
    title: string;
    updated_at: number;
    snippet: string;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT m.id, m.session_id, s.title, s.updated_at,
                snippet(messages_fts, 0, '', '', '…', 12) AS snippet
           FROM messages_fts
           JOIN messages m ON m.rowid = messages_fts.rowid
           JOIN sessions s ON s.id = m.session_id
          WHERE messages_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
      )
      .all(match, limit) as unknown as typeof rows;
  } catch {
    // A query FTS5 still refuses to parse must degrade to "no message
    // matches", never to a 500 on every keystroke.
    return hits;
  }

  for (const r of rows) {
    if (seenSessions.has(r.session_id)) continue;
    seenSessions.add(r.session_id);
    hits.push({
      sessionId: r.session_id,
      title: r.title,
      messageId: r.id,
      snippet: r.snippet,
      matchField: 'message',
      updatedAt: r.updated_at,
    });
  }
  return hits.slice(0, limit);
}
