// Drives recurring prompts ("every morning at 8, check the weather") without
// any browser tab ever needing to be open. Started once from
// instrumentation.ts when the server process boots — this file has no
// knowledge of HTTP at all, it just ticks a timer and, when a task is due,
// runs the exact same generation engine a real chat message uses
// (src/lib/generation-runner.ts) via the same job registry
// (src/lib/generation-jobs.ts) a real chat POST uses. That's what makes a
// scheduled run show up in the existing "N generating" badge/toast — it's
// not a special case, it's just another job.
import {
  listScheduledTasks,
  updateScheduledTask,
  deleteScheduledTask,
  createSession,
  updateSession,
  getSession,
  getSetting,
  type ScheduledTaskRow,
} from '@/lib/db';
import { upsertMessages } from '@/lib/chat-persistence';
import { createJob } from '@/lib/generation-jobs';
import { runGeneration, injectMemories } from '@/lib/generation-runner';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { notifyTelegram } from '@/lib/telegram-bridge';
import { safeUuid } from '@/lib/utils';
import type { ChatMessage } from '@/store/chat';

const TICK_INTERVAL_MS = 60_000;

// Finds the next moment (strictly after `from`) that matches `timeOfDay`
// ('HH:MM', server-local) and one of `daysOfWeek` (JS Date.getDay()
// convention: 0 = Sunday). Scans up to 7 days ahead, which always finds a
// match as long as daysOfWeek is non-empty (enforced by the create/update
// API route).
export function computeNextRunAt(timeOfDay: string, daysOfWeek: number[], from: Date): number {
  const [hh, mm] = timeOfDay.split(':').map(Number);
  for (let addDays = 0; addDays <= 7; addDays++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + addDays);
    candidate.setHours(hh, mm, 0, 0);
    if (candidate.getTime() <= from.getTime()) continue; // strictly future
    if (daysOfWeek.includes(candidate.getDay())) return candidate.getTime();
  }
  // Unreachable in practice (daysOfWeek is never empty), but keep the
  // scheduler alive rather than throwing if it somehow happens.
  return from.getTime() + 24 * 60 * 60 * 1000;
}

function formatRunTitle(taskName: string, at: Date): string {
  return `${taskName} — ${at.toLocaleDateString('de-DE')} ${at.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`;
}

async function runScheduledTask(task: ScheduledTaskRow): Promise<void> {
  const base = resolveOllamaHostServer(); // no req — falls through to the active DB host
  if (!base) {
    console.error(`Scheduled task "${task.name}" skipped: no Ollama host configured`);
    return;
  }

  const session = createSession({ profileId: null });
  updateSession(session.id, { title: formatRunTitle(task.name, new Date()), titleStatus: 'ready' });

  const userMessage: ChatMessage = {
    id: safeUuid(),
    role: 'user',
    content: task.prompt,
    model: task.model,
    sessionId: session.id,
    createdAt: Date.now(),
  };
  const assistantMessage: ChatMessage = {
    id: safeUuid(),
    role: 'assistant',
    content: '',
    model: task.model,
    sessionId: session.id,
    createdAt: Date.now(),
  };
  upsertMessages(session.id, [userMessage, assistantMessage]);

  // Same effective-memory resolution as the POST /api/chat handler: a
  // session-level override (none possible here, this session is brand new)
  // falls back to the global setting.
  const memoryEnabled =
    getSession(session.id)?.memoryEnabled ??
    getSetting<{ memoryEnabled: boolean }>('memory')?.memoryEnabled ??
    true;

  // A one-off reminder's prompt is phrased as an instruction the model wrote
  // to itself (see CREATE_REMINDER_TOOL's description in
  // generation-runner.ts), delivered here with no other context — without
  // framing, a model that also sees the create_reminder tool available can
  // mistake it for a fresh request to schedule *another* reminder instead of
  // recognizing "this is the reminder, firing now" (observed live in
  // testing). Only wraps what's SENT to the model — the persisted/displayed
  // user message stays the clean original text, same split already used for
  // memory injection (injectMemories) below.
  const promptForModel = task.recurring
    ? task.prompt
    : `[System: it is now the exact moment a reminder you set is due to be delivered. This is not a request to schedule anything, and the timing is correct — do not comment on dates or timing at all.]\n\nDeliver this reminder to the user now, as your entire reply, in your own words: "${task.prompt}"`;

  const job = createJob(assistantMessage.id, {
    sessionId: session.id,
    column: 'A',
    model: task.model,
  });
  await runGeneration(job, {
    base,
    model: task.model,
    messages: memoryEnabled
      ? injectMemories([{ role: 'user', content: promptForModel }])
      : [{ role: 'user', content: promptForModel }],
    think: false,
    options: undefined,
    toolsEnabled: task.toolsEnabled,
    memoryEnabled,
    searxngTemplate: null, // server-side default (SEARXNG_HOST env), no per-request header here
    // A one-off reminder is itself the fired create_reminder call — hide it
    // during delivery so the model can't mistake "deliver this now" for
    // "schedule this again" (see buildTools' doc comment in
    // generation-runner.ts). remember_fact is hidden for the same reason:
    // with create_reminder gone, a model still primed to "do something"
    // rather than just reply reached for remember_fact instead, filing the
    // reminder text away as a durable memory instead of speaking it
    // (observed live in testing) — a delivery run has no legitimate reason
    // to persist a new memory either way.
    excludeTools: task.recurring ? [] : ['create_reminder', 'remember_fact'],
  });

  if (task.recurring) {
    updateScheduledTask(task.id, { lastRunAt: Date.now(), lastRunSessionId: session.id });
  } else {
    // One-off reminder (create_reminder tool) — it already did its one job,
    // nothing to keep around. No lastRunAt bookkeeping needed on a row
    // that's about to disappear.
    deleteScheduledTask(task.id);
  }

  // Otherwise a scheduled run's only trace is a new session nobody's told
  // about until they happen to open the app — the entire point of a
  // reminder set from Telegram is to still reach you if the browser was
  // never open. No-ops silently if the Telegram bridge isn't configured.
  const finalContent = getSession(session.id)?.messages.find(
    (m) => m.id === assistantMessage.id,
  )?.content;
  if (finalContent) {
    // task.name for a one-off reminder is just a truncated echo of the
    // reminder text itself (see create_reminder's handler in
    // generation-runner.ts) — a fixed "Reminder" label reads better than
    // repeating that right above the reminder's own delivered content.
    const prefix = task.recurring ? `🔁 *${task.name}*` : '⏰ *Reminder*';
    void notifyTelegram(`${prefix}\n\n${finalContent}`);
  }
}

function tick(): void {
  const now = Date.now();
  for (const task of listScheduledTasks()) {
    if (!task.enabled || !task.nextRunAt || task.nextRunAt > now) continue;
    if (task.recurring) {
      // Advance next_run_at BEFORE the async run starts. This happens
      // synchronously (no await between the listScheduledTasks() read above
      // and this write), so a task can't be double-fired even if tick() were
      // somehow re-entered before the run finishes — by the time any other
      // code could observe this task again, next_run_at is already in the
      // future.
      updateScheduledTask(task.id, {
        nextRunAt: computeNextRunAt(task.timeOfDay, task.daysOfWeek, new Date(now)),
      });
    } else {
      // One-off reminder: disable synchronously right away for the same
      // double-fire-prevention reason — the row itself gets deleted once
      // the run actually completes (see runScheduledTask).
      updateScheduledTask(task.id, { enabled: false });
    }
    void runScheduledTask(task).catch((e) => {
      console.error(`Scheduled task "${task.name}" (${task.id}) failed:`, e);
    });
  }
}

// Guards against starting a second interval on Next.js dev's hot-reload
// (this module gets re-evaluated on every edit during `next dev`, but the
// server process itself — and this global — persists across reloads).
declare global {
  var __ollamaUiSchedulerStarted: boolean | undefined;
}

export function startScheduler(): void {
  if (globalThis.__ollamaUiSchedulerStarted) return;
  globalThis.__ollamaUiSchedulerStarted = true;
  tick(); // catch up immediately (e.g. a task's time already passed while the server was down)
  setInterval(tick, TICK_INTERVAL_MS);
}
