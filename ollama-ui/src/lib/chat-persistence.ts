// Server-side completion logic for a chat generation job: writing the final
// assistant message (and, when appropriate, the session title) back to the
// SQLite DB directly — independent of whether any browser tab is still
// listening. This is what makes generation survive a closed tab: the
// generation loop in src/app/api/chat/route.ts calls these functions itself
// once it's done, instead of relying on the client's own persistence.
import { getSession, updateSession } from '@/lib/db';
import { generateSessionTitle } from '@/lib/session-title';
import type { ChatMessage, ChatStats, TraceEvent } from '@/store/chat';

// Returns false if the session doesn't exist (caller should respond 404).
export function upsertMessages(sessionId: string, incoming: ChatMessage[]): boolean {
  const session = getSession(sessionId);
  if (!session) return false;
  const byId = new Map(session.messages.map((m) => [m.id, m]));
  for (const m of incoming) byId.set(m.id, m);
  updateSession(sessionId, { messages: [...byId.values()] });
  return true;
}

export function persistFinalAssistantMessage(
  sessionId: string,
  assistantId: string,
  patch: { content: string; trace?: TraceEvent[]; stats?: ChatStats },
): void {
  const session = getSession(sessionId);
  if (!session) return; // session deleted mid-flight — nothing to persist into
  const messages = session.messages.map((m) =>
    m.id === assistantId
      ? { ...m, content: patch.content, trace: patch.trace, stats: patch.stats }
      : m,
  );
  updateSession(sessionId, { messages });
}

// Mirrors the gating logic that used to live client-side in
// use-column-chat.ts: only column A drives title generation, only once, only
// once there are exactly the first user+assistant pair.
export async function maybeGenerateAndPersistTitle(
  base: string,
  sessionId: string,
  column: 'A' | 'B',
  model: string,
): Promise<string | null> {
  if (column !== 'A') return null;
  const session = getSession(sessionId);
  if (!session || session.titleStatus !== 'pending') return null;
  const columnAMessages = session.messages.filter((m) => (m.column ?? 'A') === 'A');
  if (columnAMessages.length !== 2) return null;
  const firstUser = columnAMessages.find((m) => m.role === 'user');
  const firstAssistant = columnAMessages.find((m) => m.role === 'assistant');
  if (!firstUser?.content || !firstAssistant?.content) return null;
  try {
    const title = await generateSessionTitle(
      base,
      model,
      firstUser.content,
      firstAssistant.content,
    );
    updateSession(sessionId, { title, titleStatus: 'ready' });
    return title;
  } catch {
    // best-effort; leave titleStatus pending, matches the "never block chat" contract
    return null;
  }
}
