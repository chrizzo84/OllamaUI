// Shared between src/app/api/chat/route.ts and src/lib/telegram-bridge.ts:
// a model can claim "I've scheduled that" in its final text without ever
// having actually called create_reminder or create_recurring_task, or after
// every attempt failed validation (observed live via the Telegram bridge —
// see its own retry logic in handleMessage — for BOTH tools independently:
// create_reminder first, then create_recurring_task again once it existed).
// The trace is the only trustworthy signal; text-pattern-matching the reply
// itself would mean guessing at phrasing across languages and models.
//
// Also handles the inverse, worse failure: asked "what's scheduled?", a
// model can skip list_scheduled_tasks entirely and confabulate a plausible-
// looking table from names mentioned earlier in the conversation (observed
// live — it invented three recurring tasks that never existed, with made-up
// times, formatted as a convincing markdown table). A create/schedule claim
// only needs a warning since the underlying action either happened or
// didn't; a *list* is pure misinformation about the user's own data if
// fabricated, so that path overrides the reply with the real, deterministic
// result instead of just flagging it. Pulls in db.ts for that — this file
// is server-only now (fine: both current importers already are).
import { listScheduledTasks } from '@/lib/db';
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

// cancel_scheduled_task belongs here too — SCHEDULE_INTENT_RE matches on
// schedule-shaped *vocabulary* ("täglich", "erinner", …), not specifically
// "the user wants to create something": a cancellation request matches it
// just as often (e.g. "storniere die tägliche Wettervorhersage") and needs
// to count as success too. Without this, a cancel that worked correctly on
// the first try still triggered a pointless retry and a false "couldn't
// confirm" warning (observed live — the task really was gone, cancelled
// cleanly, but the check only recognized the two create_* tools).
const SCHEDULING_TOOLS = ['create_reminder', 'create_recurring_task', 'cancel_scheduled_task'];

export function hasSuccessfulToolCall(trace: TraceEvent[] | undefined, toolName: string): boolean {
  return !!trace?.some((t) => t.type === 'tool' && t.name === toolName && !t.error);
}

export function hasAnySuccessfulSchedulingCall(trace: TraceEvent[] | undefined): boolean {
  return SCHEDULING_TOOLS.some((name) => hasSuccessfulToolCall(trace, name));
}

// Returns a warning suffix to append to the assistant's reply if the user's
// own message looked schedule-shaped but none of the three tools
// (create_reminder, create_recurring_task, cancel_scheduled_task) actually
// succeeded — null if nothing looked wrong (either not schedule-shaped, or
// it genuinely worked).
export function scheduleVerificationWarning(
  userText: string,
  trace: TraceEvent[] | undefined,
): string | null {
  if (!SCHEDULE_INTENT_RE.test(userText)) return null;
  if (hasAnySuccessfulSchedulingCall(trace)) return null;
  return "\n\n⚠️ I couldn't confirm that actually went through — check the Scheduled page, or try again with a more explicit request.";
}

// Deliberately broad, same reasoning as SCHEDULE_INTENT_RE above.
export const LIST_INTENT_RE =
  /was.*(geplant|erinnerungen|aufgaben)|meine (erinnerungen|aufgaben|reminders?|tasks?)|welche (aufgaben|erinnerungen)|what.*(scheduled|reminders?|tasks?)|list (my )?(reminders?|tasks?|scheduled)|show (my )?(reminders?|tasks?)/i;

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Same formatting src/lib/telegram-bridge.ts's /tasks command uses — kept
// here instead of imported from there since that file has no reason to be a
// dependency of api/chat/route.ts.
export function formatScheduledTasksList(): string {
  const tasks = listScheduledTasks();
  if (tasks.length === 0) return 'Nothing currently scheduled.';
  const lines = tasks.map((t) => {
    const when = t.recurring
      ? `${t.timeOfDay} on ${t.daysOfWeek
          .slice()
          .sort()
          .map((d) => DAY_LABELS[d])
          .join(', ')}`
      : t.nextRunAt
        ? new Date(t.nextRunAt).toLocaleString()
        : 'unknown time';
    return `${t.recurring ? '🔁' : '⏰'} ${t.name} — ${when}`;
  });
  return `Scheduled:\n${lines.join('\n')}`;
}

// Returns a replacement for the assistant's entire reply if the user's own
// message asked what's scheduled but list_scheduled_tasks was never
// actually (successfully) called — null if nothing looked wrong. Unlike
// scheduleVerificationWarning, this *replaces* rather than appends: there's
// nothing worth salvaging from a confabulated list, and the real answer is
// cheap to compute directly (no model needed for a plain read).
export function listVerificationOverride(
  userText: string,
  trace: TraceEvent[] | undefined,
): string | null {
  if (!LIST_INTENT_RE.test(userText)) return null;
  if (hasSuccessfulToolCall(trace, 'list_scheduled_tasks')) return null;
  return formatScheduledTasksList();
}
