// Server-side completion logic for a chat generation job: writing the final
// assistant message back to the SQLite DB directly — independent of whether
// any browser tab is still listening. This is what makes generation survive
// a closed tab: the generation loop in src/app/api/chat/route.ts calls these
// functions itself once it's done, instead of relying on the client's own
// persistence. (Session titles are derived client-side from the first
// message — see deriveSessionTitle in src/lib/utils.ts — so they don't need
// any server-side completion step.)
import { getSession, updateSession } from '@/lib/db';
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
