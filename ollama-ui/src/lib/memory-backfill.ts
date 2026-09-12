/**
 * Reading the past conversations for facts nobody collected at the time.
 *
 * The per-reply extractor (memory-extract.ts) only ever sees the message
 * being answered, so it can only catch facts from the moment it existed
 * onwards. Everything said before that is unexamined — and that is usually
 * where the durable facts are, because people explain their setup, their
 * preferences and who they are early on and then never repeat it.
 *
 * This is the same extraction, applied backwards. It is also the job the
 * night shift will run on a schedule: one pass over whatever is new, in the
 * background, writing drafts rather than facts. Building it as something a
 * person starts by hand first means the mechanism is observable before it is
 * given a timer.
 *
 * Three properties it has to have, and the reasons they are not optional:
 *
 *  - **Resumable.** Each conversation costs one model call — minutes of GPU
 *    time over a long history — so a stopped or crashed run must not start
 *    over. Its messages are marked as scanned once it has been read, whether
 *    or not it yielded anything.
 *  - **Sequential.** A local Ollama serves a limited number of requests at
 *    once; firing the whole history at it would mostly produce queueing, and
 *    would occupy the GPU the user is trying to chat with. One at a time,
 *    with the run abandonable at any point.
 *  - **A conversation at a time, not a message at a time.** Measured on the
 *    same ten-turn conversation: message by message it found one fact in
 *    five model calls; the whole transcript in one call found three. Context
 *    the per-message pass cannot have, at a fifth of the cost.
 *  - **Oldest first.** Facts arrive in the order they became true, so
 *    processing them in order lets a later fact supersede an earlier one
 *    exactly as it would have live. Newest-first would leave the outdated
 *    version standing as the current one.
 */
import {
  listUnscannedConversations,
  countUnscannedConversations,
  countUnscannedMessages,
  countScannedMessages,
  markMessageScanned,
  type ScanConversation,
} from '@/lib/db';
import { extractFromConversation } from '@/lib/memory-extract';

export interface BackfillProgress {
  status: 'idle' | 'running' | 'done' | 'stopped' | 'error';
  /** Conversations examined in this run. */
  processed: number;
  /** How many this run will look at in total. */
  total: number;
  /** Drafts written in this run. */
  found: number;
  /** Facts the extractor proposed that were already known. */
  duplicates: number;
  /** Messages covered so far — what the conversations above amount to. */
  messages: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  model: string | null;
}

const idle = (): BackfillProgress => ({
  status: 'idle',
  processed: 0,
  total: 0,
  found: 0,
  duplicates: 0,
  messages: 0,
  startedAt: null,
  finishedAt: null,
  error: null,
  model: null,
});

/*
Module-level, like the chat job registry: one backfill at a time per server
process, and the run outlives the request that started it. Nothing about it
is worth persisting — a run interrupted by a restart simply resumes from the
scan marks, which is the whole point of keeping those in the database.
*/
let current: BackfillProgress = idle();
let abort: AbortController | null = null;

export function getBackfillProgress(): BackfillProgress & {
  remaining: number;
  remainingConversations: number;
  scanned: number;
} {
  return {
    ...current,
    remaining: countUnscannedMessages(),
    remainingConversations: countUnscannedConversations(),
    scanned: countScannedMessages(),
  };
}

export function stopBackfill(): boolean {
  if (current.status !== 'running') return false;
  abort?.abort();
  return true;
}

export interface StartBackfillParams {
  base: string;
  model: string;
  /** Upper bound for one run, so a huge history can be worked through in sittings. */
  limit?: number;
}

/**
 * Starts a run and returns immediately; progress is polled through
 * getBackfillProgress. Returns false when one is already running, so a
 * double-click cannot start a second pass over the same messages.
 */
export function startBackfill(params: StartBackfillParams): boolean {
  if (current.status === 'running') return false;
  const candidates = listUnscannedConversations(params.limit ?? 50);
  // Nothing left to read is not a run: reporting "started" for a pass with
  // no work leaves the UI waiting for a finish that already happened.
  if (!candidates.length) return false;
  abort = new AbortController();
  current = {
    ...idle(),
    status: 'running',
    total: candidates.length,
    startedAt: Date.now(),
    model: params.model,
  };
  void run(candidates, params, abort.signal);
  return true;
}

async function run(
  conversations: ScanConversation[],
  params: StartBackfillParams,
  signal: AbortSignal,
): Promise<void> {
  try {
    for (const conversation of conversations) {
      if (signal.aborted) {
        current = { ...current, status: 'stopped', finishedAt: Date.now() };
        return;
      }

      const result = await extractFromConversation({
        base: params.base,
        model: params.model,
        turns: conversation.turns,
        sessionId: conversation.sessionId,
        signal,
      });

      /*
      Marked after the call, and every message of the conversation at once:
      the extractor saw them together, so they were examined together. A run
      interrupted before this point leaves the conversation unmarked and it
      is read again next time — repeating one call is a far better failure
      than silently skipping a conversation nobody will ever look at again.
      */
      for (const id of conversation.messageIds) markMessageScanned(id, 0);
      current = {
        ...current,
        processed: current.processed + 1,
        messages: current.messages + conversation.messageIds.length,
        found: current.found + result.saved,
        duplicates: current.duplicates + result.duplicates,
      };
    }
    current = { ...current, status: 'done', finishedAt: Date.now() };
  } catch (e) {
    // A failure part-way through keeps whatever it already found and already
    // marked, so resuming skips that work rather than repeating it.
    current = {
      ...current,
      status: 'error',
      error: e instanceof Error ? e.message : 'Backfill failed',
      finishedAt: Date.now(),
    };
  } finally {
    abort = null;
  }
}
