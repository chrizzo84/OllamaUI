import { NextRequest } from 'next/server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { createJob, publish, settleJob, createJobEventStream } from '@/lib/generation-jobs';
import { upsertMessages, persistFinalAssistantMessage } from '@/lib/chat-persistence';
import { getSession, getSetting } from '@/lib/db';
import { runGeneration, injectMemories, type ChatMessageIn } from '@/lib/generation-runner';
import { scheduleVerificationWarning, listVerificationOverride } from '@/lib/schedule-verify';
import {
  getEffectiveSearxngTemplate,
  getGloballyDisabledToolNames,
} from '@/lib/tool-settings-server';
import type { ChatMessage } from '@/store/chat';

export const runtime = 'nodejs';

/*
POST body: {
  model: string, messages: {...}[], think?: boolean, options?: object,
  toolsEnabled?: boolean, sessionId: string, column?: 'A'|'B',
  userMessage: ChatMessage, assistantMessage: ChatMessage,
}
The SearXNG endpoint for web_search comes from the stored Settings -> Tools
value (tool-settings-server.ts), never from a request header.

Starts a server-side generation job (src/lib/generation-jobs.ts) that runs
independently of this HTTP connection, then returns a ReadableStream that
tails the job's events as NDJSON — identical wire format to before. If the
client disconnects (tab closed), the stream's `cancel()` only unsubscribes;
the job keeps running and persists its result directly to the DB. Explicit
cancellation goes through DELETE /api/chat/jobs/[id] instead.

The actual generation loop (tool-calling, memory injection, benchmark
logging) lives in src/lib/generation-runner.ts — extracted so scheduled
tasks (src/lib/scheduler.ts) can drive the exact same engine without going
through this HTTP handler at all.
*/
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const model = (body.model as string | undefined)?.trim();
    const clientMessages: ChatMessageIn[] = Array.isArray(body.messages) ? body.messages : [];
    const think = body.think === true; // only enable if client explicitly requests it
    const options = typeof body.options === 'object' && body.options ? body.options : undefined;
    const toolsEnabled = body.toolsEnabled === true;
    const searxngTemplate = getEffectiveSearxngTemplate();
    const sessionId = (body.sessionId as string | undefined)?.trim();
    const column: 'A' | 'B' = body.column === 'B' ? 'B' : 'A';
    const userMessage = body.userMessage as ChatMessage | undefined;
    const assistantMessage = body.assistantMessage as ChatMessage | undefined;
    /*
    Branch targets, both optional and mutually exclusive in practice:
      parentMessageId    — regenerate: hang the new reply off the question
                           that prompted it, leaving the old reply as a sibling.
      siblingOfMessageId — edit: the rewritten question becomes an alternative
                           to the original rather than replacing it.
    Absent for an ordinary send, which just appends to the end of the thread.
    */
    const parentMessageId =
      typeof body.parentMessageId === 'string' ? body.parentMessageId : undefined;
    const siblingOfMessageId =
      typeof body.siblingOfMessageId === 'string' ? body.siblingOfMessageId : undefined;

    if (!model) {
      return new Response(JSON.stringify({ error: 'Missing model' }), { status: 400 });
    }
    if (!sessionId || !assistantMessage?.id) {
      return new Response(JSON.stringify({ error: 'Missing sessionId or assistantMessage' }), {
        status: 400,
      });
    }
    // Effective memory setting is resolved here, server-side, from the DB —
    // never trusted from the client — so a session's explicit override
    // (SessionRow.memoryEnabled: true/false) wins over the global default,
    // and an unset session (null) falls back to it. See db.ts's SessionRow
    // and api/settings/memory/route.ts.
    const sessionForMemory = getSession(sessionId);
    if (!sessionForMemory) {
      return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 });
    }
    const memoryEnabled =
      sessionForMemory.memoryEnabled ??
      getSetting<{ memoryEnabled: boolean }>('memory')?.memoryEnabled ??
      true;
    const base = resolveOllamaHostServer();
    if (!base) {
      return new Response(JSON.stringify({ error: 'No host configured', code: 'NO_HOST' }), {
        status: 428,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Durably write the user message + empty assistant placeholder BEFORE
    // touching Ollama at all — this is what makes closing the tab safe even
    // immediately after hitting send, not just mid-stream. Previously this
    // was a client-side, unawaited PATCH that a fast tab-close could lose.
    // Any images the browser attached ride along as base64 on the user
    // message; the persistence layer turns them into stored attachments (see
    // resolveAttachments in src/lib/db.ts) so nothing here has to.
    const toUpsert = userMessage?.id ? [userMessage, assistantMessage] : [assistantMessage];
    const ok = upsertMessages(sessionId, toUpsert, { parentMessageId, siblingOfMessageId });
    if (!ok) {
      return new Response(JSON.stringify({ error: 'Session not found' }), { status: 404 });
    }

    // Creating the job before building the event stream (rather than after)
    // matters: createJobEventStream subscribes synchronously, and
    // runGeneration is only kicked off below, after that subscription
    // exists — so no event can ever be published before something is
    // listening for it.
    const job = createJob(assistantMessage.id, { sessionId, column, model });
    const transformed = createJobEventStream(job.id)!; // job was just created above, always found

    // Fire-and-forget: NOT awaited, so it keeps running after this handler
    // returns and even after the response stream above is torn down. The
    // .catch is a last-resort net — everything inside runGeneration already
    // settles the job and persists on every normal exit path, but an
    // unexpected throw here would otherwise become an unhandled rejection in
    // this long-running process instead of a contained per-request failure.
    void runGeneration(job, {
      base,
      model,
      messages: memoryEnabled ? injectMemories(clientMessages) : clientMessages,
      think,
      options,
      toolsEnabled,
      memoryEnabled,
      searxngTemplate,
      // Settings → Tools individual toggles (Telegram/scheduled tasks read
      // the same list) — resolved server-side, not trusted from the
      // client, same reasoning as memoryEnabled just above.
      excludeTools: getGloballyDisabledToolNames(),
      // A model can say "reminder set"/"scheduled that"/"cancelled that"
      // without ever successfully calling the matching tool (create_reminder,
      // create_recurring_task, cancel_scheduled_task)
      // (observed live via the Telegram bridge, which does a full
      // corrective retry — not practical here since the reply has already
      // streamed to the browser by the time this runs; a warning appended
      // to the persisted/displayed content is the honest option that fits
      // a live-streaming UI instead).
      postProcess: ({ content, trace }) => {
        const lastUserText =
          [...clientMessages].reverse().find((m) => m.role === 'user')?.content ?? '';
        // A confabulated *list* of scheduled tasks is misinformation about
        // the user's own data, not just an unconfirmed action — replaced
        // outright rather than merely flagged (see listVerificationOverride's
        // doc comment in schedule-verify.ts).
        const listOverride = listVerificationOverride(lastUserText, trace);
        if (listOverride) return listOverride;
        const warning = scheduleVerificationWarning(lastUserText, trace);
        return warning ? content + warning : undefined;
      },
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      publish(job.id, { error: message });
      settleJob(job.id, 'error');
      persistFinalAssistantMessage(sessionId, job.id, { content: '[Error] ' + message });
      publish(job.id, { streamEnd: true });
    });

    return new Response(transformed, {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Chat failed';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
