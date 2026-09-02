import { NextRequest } from 'next/server';
import { searchMessages } from '@/lib/db';

export const runtime = 'nodejs';

/*
GET /api/sessions/search?q=<query>
Full-text search over session titles and message content.

This used to load every session and scan the whole history in memory on each
keystroke, on the grounds that one person's chat log is small. It stops
being small surprisingly fast once conversations are long, and the work grew
with the total size of the archive rather than with the number of matches.
The search now runs against an FTS5 index (see searchMessages in
src/lib/db.ts), which SQLite maintains automatically as messages are
written.
*/
export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get('q') || '').trim();
  if (!q) return Response.json({ results: [] });
  const results = searchMessages(q).map((hit) => ({
    id: hit.sessionId,
    title: hit.title,
    updatedAt: hit.updatedAt,
    snippet: hit.snippet,
    matchField: hit.matchField,
    messageId: hit.messageId || undefined,
  }));
  return Response.json({ results });
}
