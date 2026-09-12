/**
 * The night shift: the maintenance the memory needs and nobody wants to do.
 *
 * A local machine sits idle twenty-three hours a day, and its tokens cost
 * nothing but electricity. That inverts the usual economics — work that
 * would never be worth a per-token bill becomes worth doing once it happens
 * while nobody is waiting. This is that work:
 *
 *  1. **Read what is new.** Conversations that happened since the last pass
 *     get examined for durable facts (the same job the Memory page can start
 *     by hand — see memory-backfill.ts).
 *  2. **Offer to merge what overlaps.** Between "clearly the same claim",
 *     which the write path displaces on its own, and "clearly different"
 *     lies a band the write path deliberately stays out of: two facts about
 *     one machine where one carries more detail. Deciding that during a chat
 *     would cost a model call on the hot path; at night it is free. The
 *     merged wording is proposed, never applied.
 *  3. **Let episodic facts age out.** "War im Mai auf der FOSDEM" is true
 *     forever and interesting for a while. Episodic facts retrieval has
 *     never once reached for are archived after a while — archived, not
 *     deleted, so the timeline still shows it happened.
 *
 * The rule that makes this acceptable at all: **it proposes, it does not
 * decide**. Everything it extracts or merges lands as a draft in the review
 * queue. The single exception is archiving episodic facts, which is
 * reversible and touches nothing that shapes behaviour — no identity, no
 * preference, nothing pinned, nothing that was ever used.
 *
 * Unattended generation is the riskiest mode this app has, so every run is
 * recorded (memory_maintenance_runs) and every run is bounded: a wall-clock
 * budget, a conversation cap, and an abort that takes effect between steps.
 */
import {
  listMergeCandidates,
  listDecayableMemories,
  archiveMemory,
  remember,
  addEdge,
  startMaintenanceRun,
  updateMaintenanceRun,
  listMaintenanceRuns,
  countUnscannedConversations,
  getSetting,
  type MemoryRow,
} from '@/lib/db';
import { startBackfill, getBackfillProgress, stopBackfill } from '@/lib/memory-backfill';
import { stripWikiLinks } from '@/lib/memory-links';

export interface NightShiftSettings {
  enabled: boolean;
  /** Server-local 'HH:MM'. */
  timeOfDay: string;
  /** Empty means "whatever model is configured for scheduled tasks". */
  model: string;
  /** Conversations to read per run, so a huge history is worked through over several nights. */
  conversationLimit: number;
  /** Episodic facts untouched for this long and never retrieved are archived. */
  decayDays: number;
}

export const DEFAULT_NIGHT_SHIFT: NightShiftSettings = {
  enabled: false,
  timeOfDay: '03:30',
  model: '',
  conversationLimit: 25,
  decayDays: 120,
};

export const NIGHT_SHIFT_SETTINGS_KEY = 'memory_nightshift';

export function getNightShiftSettings(): NightShiftSettings {
  const stored = getSetting<Partial<NightShiftSettings>>(NIGHT_SHIFT_SETTINGS_KEY);
  return { ...DEFAULT_NIGHT_SHIFT, ...(stored ?? {}) };
}

/** Wall-clock ceiling for one run: it must be finished long before anyone is up. */
const RUN_BUDGET_MS = 2 * 60 * 60 * 1000;

interface RunState {
  id: string;
  abort: AbortController;
  startedAt: number;
  step: string;
}

let active: RunState | null = null;

export function isNightShiftRunning(): boolean {
  return active !== null;
}

export function currentNightShiftStep(): string | null {
  return active?.step ?? null;
}

export function stopNightShift(): boolean {
  if (!active) return false;
  active.abort.abort();
  stopBackfill();
  return true;
}

export interface NightShiftParams {
  base: string;
  model: string;
  trigger: 'schedule' | 'manual';
  settings?: NightShiftSettings;
}

/**
 * Runs one pass. Resolves when it is finished; callers that do not want to
 * wait simply do not await it. Never throws — a maintenance failure is
 * recorded in its run row, not propagated into whatever triggered it.
 */
export async function runNightShift(params: NightShiftParams): Promise<void> {
  if (active) return;
  const settings = params.settings ?? getNightShiftSettings();
  const abort = new AbortController();
  const id = startMaintenanceRun(params.trigger, params.model);
  active = { id, abort, startedAt: Date.now(), step: 'starting' };

  const overBudget = () => Date.now() - active!.startedAt > RUN_BUDGET_MS;
  let conversationsRead = 0;
  let factsFound = 0;
  let mergesProposed = 0;
  let archived = 0;

  try {
    // 1. Read what is new.
    active.step = 'reading conversations';
    if (countUnscannedConversations() > 0 && !abort.signal.aborted) {
      startBackfill({ base: params.base, model: params.model, limit: settings.conversationLimit });
      // Poll rather than await: the backfill owns its own progress and can be
      // stopped independently, which is what makes "stop the night shift"
      // take effect mid-conversation instead of at the next boundary.
      while (getBackfillProgress().status === 'running') {
        if (abort.signal.aborted || overBudget()) {
          stopBackfill();
          break;
        }
        await sleep(2000);
      }
      const progress = getBackfillProgress();
      conversationsRead = progress.processed;
      factsFound = progress.found;
      updateMaintenanceRun(id, { conversationsRead, factsFound });
    }

    // 2. Offer merges for the overlapping pairs.
    active.step = 'merging overlaps';
    if (!abort.signal.aborted && !overBudget()) {
      mergesProposed = await proposeMerges({
        base: params.base,
        model: params.model,
        signal: abort.signal,
        stop: () => abort.signal.aborted || overBudget(),
      });
      updateMaintenanceRun(id, { mergesProposed });
    }

    // 3. Let old episodic facts age out.
    active.step = 'archiving stale facts';
    if (!abort.signal.aborted) {
      const stale = listDecayableMemories(settings.decayDays * 24 * 60 * 60 * 1000);
      for (const memory of stale) archiveMemory(memory.id);
      archived = stale.length;
      updateMaintenanceRun(id, { archived });
    }

    updateMaintenanceRun(id, {
      status: abort.signal.aborted ? 'stopped' : 'done',
      finished: true,
    });
  } catch (e) {
    updateMaintenanceRun(id, {
      status: 'error',
      error: e instanceof Error ? e.message : 'Maintenance failed',
      finished: true,
    });
  } finally {
    active = null;
  }
}

const MERGE_TOOL = {
  type: 'function',
  function: {
    name: 'merge_facts',
    description:
      'Combine two overlapping facts about the user into one sentence that keeps every detail from both. Only call this if they really are about the same thing and one sentence can carry both without inventing anything.',
    parameters: {
      type: 'object',
      properties: {
        merged: {
          type: 'string',
          description:
            'The combined fact, one sentence, in the same language as the originals, keeping every detail from both.',
        },
      },
      required: ['merged'],
    },
  },
};

/**
 * Asks the model to combine each overlapping pair, and stores the result as a
 * draft that supersedes nothing until a person approves it.
 *
 * A merge is the one operation here that can *lose* information — two facts
 * become one sentence — so it is the last thing that should happen
 * unattended. The proposal links back to both originals, so approving it is
 * an informed decision rather than a leap of faith.
 */
async function proposeMerges(params: {
  base: string;
  model: string;
  signal: AbortSignal;
  stop: () => boolean;
}): Promise<number> {
  const pairs = listMergeCandidates();
  let proposed = 0;
  for (const pair of pairs) {
    if (params.stop()) break;
    const merged = await askForMerge(params, pair.a, pair.b);
    if (!merged) continue;

    const stored = remember({
      content: merged,
      type: pair.a.type === 'unsorted' ? pair.b.type : pair.a.type,
      subject: pair.a.subject ?? pair.b.subject ?? undefined,
      // Below the draft threshold on purpose: a merge written with nobody
      // watching must not go straight into the next prompt.
      confidence: 0.4,
      sourceSessionId: pair.a.sourceSessionId ?? pair.b.sourceSessionId,
    });
    if (stored.duplicate) continue;
    // Linked to both originals so the review queue can show what it came
    // from, and so approving it reads as the history it is.
    addEdge(stored.memory.id, 'memory', pair.a.id, 'supersedes');
    addEdge(stored.memory.id, 'memory', pair.b.id, 'supersedes');
    proposed++;
  }
  return proposed;
}

async function askForMerge(
  params: { base: string; model: string; signal: AbortSignal },
  a: MemoryRow,
  b: MemoryRow,
): Promise<string | null> {
  try {
    const res = await fetch(`${params.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        stream: false,
        think: false,
        options: { temperature: 0 },
        messages: [
          {
            role: 'system',
            /*
            Phrased as an instruction rather than a set of conditions. The
            careful version — "call this only if they are really about the
            same thing, and if combining them would drop or invent anything,
            reply NONE" — produced the correct merged sentence as plain text
            and never called the tool at all, so nothing was ever stored. The
            same pattern showed up twice before in this codebase: each extra
            condition makes a small model more hesitant to reach for the
            tool, and a tool that is not called is worse than one called
            slightly too often, because a wrong proposal is caught in review
            and a missing one is invisible.
            */
            content:
              'You combine two facts about a user into a single sentence that keeps every detail ' +
              'from both. Call merge_facts with that sentence, in the language of the originals. ' +
              'If the two are about different things, reply NONE instead.',
          },
          {
            role: 'user',
            content: `1: ${stripWikiLinks(a.content)}\n2: ${stripWikiLinks(b.content)}`,
          },
        ],
        tools: [MERGE_TOOL],
      }),
      signal: params.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      message?: { tool_calls?: { function?: { name?: string; arguments?: unknown } }[] };
    };
    for (const call of data.message?.tool_calls ?? []) {
      if (call.function?.name !== 'merge_facts') continue;
      const args = (
        typeof call.function.arguments === 'string'
          ? JSON.parse(call.function.arguments)
          : call.function.arguments
      ) as { merged?: unknown };
      const merged = typeof args?.merged === 'string' ? args.merged.trim() : '';
      if (merged) return merged;
    }
    return null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Whether a scheduled run is due: the configured time has passed today and no
 * run has started since. Checked from the scheduler's existing minute tick,
 * so there is no second timer to keep alive.
 */
export function isNightShiftDue(now = new Date(), settings = getNightShiftSettings()): boolean {
  if (!settings.enabled || active) return false;
  const [hh, mm] = settings.timeOfDay.split(':').map(Number);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return false;
  const dueToday = new Date(now);
  dueToday.setHours(hh, mm, 0, 0);
  if (now.getTime() < dueToday.getTime()) return false;
  const [last] = listMaintenanceRuns(1);
  // One run per scheduled time: a pass that already started after today's
  // slot means today is done, whatever its outcome.
  return !last || last.startedAt < dueToday.getTime();
}
