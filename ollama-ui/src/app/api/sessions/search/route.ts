import { NextRequest } from 'next/server';
import { listSessions } from '@/lib/db';

export const runtime = 'nodejs';

const SNIPPET_RADIUS = 60;

// Builds a short excerpt around the first match, so the result reads like a
// search-engine snippet instead of just "found it, somewhere in there".
function makeSnippet(text: string, query: string): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, SNIPPET_RADIUS * 2).trim();
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + query.length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).trim() + suffix;
}

/*
GET /api/sessions/search?q=<query>
Full-text search over session titles and message content. Data volume here
is personal-scale (one user's chat history), so a straightforward in-memory
scan over listSessions() is simpler and plenty fast — no FTS5 virtual table
or index needed.
*/
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return Response.json({ results: [] });
  const needle = q.toLowerCase();

  const results = listSessions()
    .map((session) => {
      if (session.title.toLowerCase().includes(needle)) {
        return {
          id: session.id,
          title: session.title,
          updatedAt: session.updated_at,
          snippet: makeSnippet(session.title, q),
          matchField: 'title' as const,
        };
      }
      const match = session.messages.find(
        (m) => m.role !== 'system' && m.content.toLowerCase().includes(needle),
      );
      if (match) {
        return {
          id: session.id,
          title: session.title,
          updatedAt: session.updated_at,
          snippet: makeSnippet(match.content, q),
          matchField: 'message' as const,
        };
      }
      return null;
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

  return Response.json({ results });
}
