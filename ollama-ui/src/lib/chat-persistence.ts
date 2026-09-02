// Server-side completion logic for a chat generation job: writing the final
// assistant message back to the SQLite DB directly — independent of whether
// any browser tab is still listening. This is what makes generation survive
// a closed tab: the generation loop in src/app/api/chat/route.ts calls these
// functions itself once it's done, instead of relying on the client's own
// persistence. (Session titles are derived client-side from the first
// message — see deriveSessionTitle in src/lib/utils.ts — so they don't need
// any server-side completion step.)
//
// Both operations used to read the whole conversation, splice it in memory
// and write it back as one JSON blob. They are now single-row writes against
// the `messages` table (see src/lib/db.ts), so appending a message costs the
// same whether the conversation has three messages or three hundred.
import { upsertMessages as dbUpsertMessages, patchMessage, type UpsertOptions } from '@/lib/db';
import type { ChatMessage, ChatStats, TraceEvent } from '@/store/chat';

// Returns false if the session doesn't exist (caller should respond 404).
// `options` carries the branch target for a regenerate or an edit — see
// UpsertOptions in src/lib/db.ts.
export function upsertMessages(
  sessionId: string,
  incoming: ChatMessage[],
  options?: UpsertOptions,
): boolean {
  return dbUpsertMessages(sessionId, incoming, options);
}

export function persistFinalAssistantMessage(
  sessionId: string,
  assistantId: string,
  patch: { content: string; trace?: TraceEvent[]; stats?: ChatStats },
): void {
  patchMessage(assistantId, patch);
}
