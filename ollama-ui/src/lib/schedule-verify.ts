// Shared between src/app/api/chat/route.ts and src/lib/telegram-bridge.ts:
// a model can claim "I've scheduled that" in its final text without ever
// having actually called create_reminder or create_recurring_task, or after
// every attempt failed validation (observed live via the Telegram bridge —
// see its own retry logic in handleMessage — for BOTH tools independently:
// create_reminder first, then create_recurring_task again once it existed).
// The trace is the only trustworthy signal; text-pattern-matching the reply
// itself would mean guessing at phrasing across languages and models.
import type { TraceEvent } from '@/store/chat';

// Deliberately broad (catches an unrelated reply that merely mentions one of
// these words/phrases too) — a false positive here just means one
// unnecessary check, while a false negative means a silently-broken
// schedule goes unnoticed. Covers both one-off ("remind me"/"erinnere
// mich") and recurring ("every morning"/"jeden Morgen", "täglich", …)
// phrasing, since from the user's side "did something get scheduled" is
// what matters, not which of the two tools should have handled it.
export const SCHEDULE_INTENT_RE =
  /erinner|remind|jeden (tag|morgen|abend|woche)|täglich|wöchentlich|regelmäßig|wiederkehrend|recurring|every (day|morning|evening|weekday|week)/i;

const SCHEDULING_TOOLS = ['create_reminder', 'create_recurring_task'];

export function hasSuccessfulToolCall(trace: TraceEvent[] | undefined, toolName: string): boolean {
  return !!trace?.some((t) => t.type === 'tool' && t.name === toolName && !t.error);
}

export function hasAnySuccessfulSchedulingCall(trace: TraceEvent[] | undefined): boolean {
  return SCHEDULING_TOOLS.some((name) => hasSuccessfulToolCall(trace, name));
}

// Returns a warning suffix to append to the assistant's reply if the user's
// own message looked schedule-shaped but neither create_reminder nor
// create_recurring_task actually succeeded — null if nothing looked wrong
// (either not schedule-shaped, or it genuinely worked).
export function scheduleVerificationWarning(
  userText: string,
  trace: TraceEvent[] | undefined,
): string | null {
  if (!SCHEDULE_INTENT_RE.test(userText)) return null;
  if (hasAnySuccessfulSchedulingCall(trace)) return null;
  return "\n\n⚠️ I couldn't confirm anything was actually scheduled — check the Scheduled page, or try again with a more explicit time.";
}
