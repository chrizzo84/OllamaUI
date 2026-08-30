// Optional remote-control channel: lets a single, allowlisted Telegram user
// chat with this app from their phone, reusing the exact same tool-calling
// engine as the web UI and the scheduler (src/lib/generation-runner.ts) —
// started once from instrumentation.ts, same pattern and same Node-runtime
// constraint as startScheduler() in src/lib/scheduler.ts (node:sqlite via
// db.ts isn't available under the Edge runtime).
//
// Security model: the bot token (TELEGRAM_BOT_TOKEN) only authenticates THIS
// SERVER to Telegram's API — it does not gate who can message the bot on
// Telegram's side; any Telegram user who finds the bot's @username can send
// it a message. The actual access control is TELEGRAM_ALLOWED_USER_ID:
// Telegram's own servers stamp `message.from.id` on every update (a client
// cannot forge this), so comparing it against the configured id is what
// keeps this to one person. An update from a non-matching id is dropped
// silently — no reply — so an unauthorized prober can't even confirm the bot
// is listening.
import {
  createSession,
  getSession,
  getSetting,
  setSetting,
  updateSession,
  listScheduledTasks,
  deleteScheduledTask,
} from '@/lib/db';
import { upsertMessages, persistFinalAssistantMessage } from '@/lib/chat-persistence';
import { createJob, subscribe } from '@/lib/generation-jobs';
import { runGeneration, type ChatMessageIn } from '@/lib/generation-runner';
import { compactMessages } from '@/lib/compact';
import {
  SCHEDULE_INTENT_RE,
  hasAnySuccessfulSchedulingCall,
  formatScheduledTasksList,
  listVerificationOverride,
} from '@/lib/schedule-verify';
import { transcribeAudio, getWhisperHost } from '@/lib/whisper';
import { extractDocumentText } from '@/lib/document-extract';
import { getGloballyDisabledToolNames } from '@/lib/tool-settings-server';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { safeUuid, deriveSessionTitle } from '@/lib/utils';
import type { ChatMessage } from '@/store/chat';
import telegramifyMarkdown from 'telegramify-markdown';

const API_BASE = 'https://api.telegram.org';
// One persistent conversation for the single allowed user, so context
// carries across messages the same way a normal chat session does. Keyed in
// `settings` (not a module-level variable) so it survives a server restart.
const SESSION_SETTING_KEY = 'telegram_session_id';
// Telegram's real cap is 4096 UTF-16 code units; leave headroom rather than
// cut it exactly at the limit.
const TELEGRAM_MESSAGE_LIMIT = 3500;

interface BridgeConfig {
  token: string;
  allowedUserId: string;
  model: string | undefined;
  // Optional — used instead of `model` for a message that includes a photo.
  // Not every model can see images (see modelSupportsVision), and the main
  // TELEGRAM_MODEL is picked for general tool-calling chat, not necessarily
  // a vision-capable one.
  visionModel: string | undefined;
  // Optional — base URL of a whisper.cpp `whisper-server` instance (e.g.
  // "http://localhost:8790") for transcribing voice messages. Ollama itself
  // has no speech-to-text model support, so this is a second, separate
  // local service — see src/lib/whisper.ts. Voice messages are declined
  // with a setup message when unset.
  whisperHost: string | undefined;
}

function getConfig(): BridgeConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const allowedUserId = process.env.TELEGRAM_ALLOWED_USER_ID?.trim();
  if (!token || !allowedUserId) return null;
  return {
    token,
    allowedUserId,
    model: process.env.TELEGRAM_MODEL?.trim() || undefined,
    visionModel: process.env.TELEGRAM_VISION_MODEL?.trim() || undefined,
    whisperHost: getWhisperHost() ?? undefined,
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    chat: { id: number };
    text?: string;
    caption?: string;
    date?: number; // Unix seconds — when Telegram received the message
    // Telegram sends one entry per available resolution, smallest first —
    // the last one is the largest/highest-quality available.
    photo?: { file_id: string }[];
    voice?: { file_id: string };
    document?: { file_id: string; file_name?: string; mime_type?: string };
  };
  // Sent when the user taps an inline-keyboard button (e.g. a /tasks
  // "❌ Cancel" button) — a distinct update type, not a `message`.
  callback_query?: {
    id: string;
    from?: { id: number };
    message?: { chat: { id: number }; message_id: number };
    data?: string;
  };
}

async function callTelegram<T>(
  token: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 15_000),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Telegram ${method} failed: ${data.description ?? res.status}`);
  return data.result as T;
}

async function downloadTelegramFileBytes(token: string, fileId: string): Promise<Buffer> {
  const file = await callTelegram<{ file_path: string }>(token, 'getFile', { file_id: fileId });
  const res = await fetch(`${API_BASE}/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Returns raw base64 (no `data:...;base64,` prefix), matching
// ChatMessage.images' documented shape (src/store/chat.ts) — the same
// format the web UI's Attach button produces, so both paths feed the model
// identically.
async function downloadTelegramPhoto(token: string, fileId: string): Promise<string> {
  return (await downloadTelegramFileBytes(token, fileId)).toString('base64');
}

// Ollama's /api/show reports a model's declared capabilities (same field
// the web UI reads via POST /api/models/show to decide whether to show the
// vision badge/Attach button) — called directly against `base` here since
// this already runs server-side, no need to bounce through that route.
// Returns null (not []) when the lookup itself failed, so callers can tell
// "no capabilities" from "couldn't ask".
async function fetchModelCapabilities(base: string, model: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.capabilities) ? data.capabilities : null;
  } catch {
    return null;
  }
}

async function modelSupportsVision(base: string, model: string): Promise<boolean> {
  // Unknown (lookup failed) is treated as unsupported — safer than silently
  // sending an image to a model that might not be able to use it.
  return (await fetchModelCapabilities(base, model))?.includes('vision') ?? false;
}

// Local (server-timezone) date-time with no "Z"/offset suffix — the exact
// format create_reminder's whenISO expects (see its tool description in
// generation-runner.ts) and what get_current_date's own `date`/`time`
// fields already represent, so the model reasons in one consistent
// timezone instead of mixing this with a UTC timestamp.
function toLocalIsoLike(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(i, i + TELEGRAM_MESSAGE_LIMIT));
  }
  return chunks.length ? chunks : ['(empty reply)'];
}

// Reply markup (inline keyboard) is only attached to the final chunk — a
// multi-chunk reply is rare in practice (only a very long list/reply hits
// it), and Telegram only needs the buttons on one message anyway.
type InlineKeyboard = { inline_keyboard: { text: string; callback_data: string }[][] };

async function sendChunks(
  token: string,
  chatId: number,
  chunks: string[],
  parseMode: 'MarkdownV2' | undefined,
  replyMarkup: InlineKeyboard | undefined,
): Promise<number | undefined> {
  let lastId: number | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const result = await callTelegram<{ message_id: number }>(token, 'sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      ...(parseMode ? { parse_mode: parseMode } : {}),
      ...(i === chunks.length - 1 && replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
    lastId = result.message_id;
  }
  return lastId;
}

// Sends `text` as Telegram MarkdownV2 (so the model's normal **bold**/`code`/
// lists render instead of showing as raw asterisks/backticks). LLM markdown
// isn't guaranteed to be valid MarkdownV2 — telegramify-markdown handles the
// escaping, but a chunk boundary can still split an entity in two on a long,
// multi-chunk reply — so on any failure this resends the whole thing as
// plain text instead. A rare double-send (some chunks already went out
// formatted) is the accepted cost of never silently dropping a reply.
// Returns the last sent message's id (used to attach/edit an inline
// keyboard later), or undefined if replyMarkup wasn't requested.
async function sendMessage(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<number | undefined> {
  try {
    return await sendChunks(
      token,
      chatId,
      chunkText(telegramifyMarkdown(text, 'escape')),
      'MarkdownV2',
      replyMarkup,
    );
  } catch {
    return await sendChunks(token, chatId, chunkText(text), undefined, replyMarkup);
  }
}

async function sendStatusMessage(token: string, chatId: number, text: string): Promise<number> {
  try {
    const result = await callTelegram<{ message_id: number }>(token, 'sendMessage', {
      chat_id: chatId,
      text: telegramifyMarkdown(text, 'escape'),
      parse_mode: 'MarkdownV2',
    });
    return result.message_id;
  } catch {
    const result = await callTelegram<{ message_id: number }>(token, 'sendMessage', {
      chat_id: chatId,
      text,
    });
    return result.message_id;
  }
}

// Best-effort — a status update racing the final delete, Telegram rejecting
// a no-op edit ("message is not modified"), or a formatting edge case are
// all fine to silently drop, this is cosmetic only.
function editStatusMessage(token: string, chatId: number, messageId: number, text: string): void {
  void callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: telegramifyMarkdown(text, 'escape'),
    parse_mode: 'MarkdownV2',
  }).catch(() => {});
}

function deleteMessage(token: string, chatId: number, messageId: number): void {
  void callTelegram(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(
    () => {},
  );
}

// Telegram's "X is typing…" indicator lasts ~5s per call and needs
// refreshing while a reply is still being generated — this is purely a
// native, wordless heads-up; the status message below carries the actual
// detail (which tool is running, whether the model is queued).
function startTypingIndicator(token: string, chatId: number): () => void {
  const tick = () =>
    void callTelegram(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(
      () => {},
    );
  tick();
  const interval = setInterval(tick, 4000);
  return () => clearInterval(interval);
}

// Turns a tool call's arguments into a short, human-readable hint for the
// status message — best-effort across tools with different argument shapes
// rather than a per-tool switch, since new tools shouldn't need to touch this.
function summarizeToolCall(name: string, args: unknown): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  const hint = a.query ?? a.location ?? a.expression ?? a.message ?? a.fact ?? '';
  const hintText = typeof hint === 'string' && hint.trim() ? `: "${hint.trim().slice(0, 60)}"` : '';
  return `🔧 Using \`${name}\`${hintText}…`;
}

// Starts (or, via /new, restarts) the one persistent Telegram conversation —
// the old session isn't deleted, just abandoned, so it stays visible in the
// web UI's session list if you ever want to look back at it.
function createNewTelegramSession(): string {
  const row = createSession({ profileId: null });
  updateSession(row.id, { title: 'Telegram' });
  setSetting(SESSION_SETTING_KEY, row.id);
  return row.id;
}

function getOrCreateSessionId(): string {
  const existingId = getSetting<string>(SESSION_SETTING_KEY);
  if (existingId && getSession(existingId)) return existingId;
  return createNewTelegramSession();
}

// Registered with Telegram once at startup (setMyCommands) so they show up
// as autocomplete in the client, in addition to just working when typed.
const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'info', description: 'Show the current model and what it can do' },
  { command: 'tasks', description: 'List scheduled tasks and pending reminders' },
  { command: 'new', description: 'Start a fresh conversation (clears context)' },
  { command: 'help', description: 'List available commands' },
];

const HELP_TEXT = [
  '**Commands:**',
  '/info — show the current model and what it can do',
  '/tasks — list scheduled tasks and pending reminders (tap ❌ to cancel one)',
  '/new — start a fresh conversation (clears context)',
  '/help — show this message',
  '',
  'Anything else is sent straight to the model — text, a photo/voice message, or a document (PDF/text/code — attach it to summarize or ask about it). Ask it to cancel a reminder or task by name too.',
].join('\n');

// One "❌ Cancel" button per task, callback_data `cancel_task:<id>` — well
// under Telegram's 64-byte limit (safeUuid ids are 36 chars). undefined (no
// keyboard at all) when nothing's scheduled, so an empty list doesn't show a
// dangling empty button row.
function buildTasksKeyboard(): InlineKeyboard | undefined {
  const tasks = listScheduledTasks();
  if (tasks.length === 0) return undefined;
  return {
    inline_keyboard: tasks.map((t) => [
      { text: `❌ Cancel: ${t.name.slice(0, 40)}`, callback_data: `cancel_task:${t.id}` },
    ]),
  };
}

async function handleTasksCommand(token: string, chatId: number): Promise<void> {
  await sendMessage(
    token,
    chatId,
    `${formatScheduledTasksList()}\n\nTap Cancel below, or just ask to cancel one by name.`,
    buildTasksKeyboard(),
  );
}

// Re-renders an already-sent tasks-list message in place after a button
// tap — same list/keyboard-building logic as handleTasksCommand, just an
// edit instead of a new message so the chat doesn't fill up with one
// message per cancellation. Explicitly clears reply_markup to `[]` when
// nothing's left scheduled, since omitting the field entirely would leave
// Telegram showing the old (now-stale) buttons.
async function editTasksMessage(token: string, chatId: number, messageId: number): Promise<void> {
  const text = formatScheduledTasksList();
  const replyMarkup = buildTasksKeyboard() ?? { inline_keyboard: [] };
  try {
    await callTelegram(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: telegramifyMarkdown(text, 'escape'),
      parse_mode: 'MarkdownV2',
      reply_markup: replyMarkup,
    });
  } catch {
    await callTelegram(token, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      reply_markup: replyMarkup,
    }).catch(() => {});
  }
}

// A button tap only ever carries `cancel_task:<id>` here (the only kind this
// bridge sends) — cancels immediately (no LLM round-trip, same reasoning as
// the slash commands: instant and deterministic) and answers the callback so
// Telegram clears the button's loading spinner, with a short toast either
// way (confirming, or noting it was already gone — e.g. two taps in a row,
// or it fired on its own between the list being shown and the tap).
async function handleCallbackQuery(
  token: string,
  chatId: number,
  messageId: number,
  callbackQueryId: string,
  data: string,
): Promise<void> {
  if (!data.startsWith('cancel_task:')) {
    await callTelegram(token, 'answerCallbackQuery', { callback_query_id: callbackQueryId }).catch(
      () => {},
    );
    return;
  }
  const id = data.slice('cancel_task:'.length);
  const task = listScheduledTasks().find((t) => t.id === id);
  await callTelegram(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: task ? `Cancelled "${task.name}".` : 'Already gone.',
  }).catch(() => {});
  if (task) deleteScheduledTask(id);
  await editTasksMessage(token, chatId, messageId);
}

async function handleInfoCommand(
  token: string,
  chatId: number,
  model: string | undefined,
): Promise<void> {
  if (!model) {
    await sendMessage(token, chatId, '[Setup] TELEGRAM_MODEL is not set in .env.local.');
    return;
  }
  const base = resolveOllamaHostServer();
  if (!base) {
    await sendMessage(token, chatId, '[Error] No Ollama host configured.');
    return;
  }
  const caps = await fetchModelCapabilities(base, model);
  await sendMessage(
    token,
    chatId,
    [
      `**Model:** \`${model}\``,
      caps
        ? `**Capabilities:** ${caps.join(', ')}`
        : '**Capabilities:** unknown (could not reach Ollama)',
    ].join('\n'),
  );
}

// Returns true if `text` was a recognized (or at least slash-shaped) command
// and has been fully handled — the caller should not fall through to the
// model in that case. Slash commands never reach the LLM: instant and
// deterministic instead of an unreliable, wasted generation call (this is
// also what fixes /start previously getting sent through as normal chat
// text and getting an oddly literal reply).
async function handleCommand(
  token: string,
  chatId: number,
  model: string | undefined,
  text: string,
): Promise<boolean> {
  if (!text.startsWith('/')) return false;
  // Telegram sometimes appends "@BotUsername" to a command (default client
  // behavior in some contexts even in private chats).
  const command = text.trim().split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();

  switch (command) {
    case 'start':
      await sendMessage(
        token,
        chatId,
        `👋 Connected. Send a message to chat, or a photo/voice message/document. Commands: /info, /tasks, /new, /help.`,
      );
      return true;
    case 'info':
      await handleInfoCommand(token, chatId, model);
      return true;
    case 'tasks':
      await handleTasksCommand(token, chatId);
      return true;
    case 'new':
      createNewTelegramSession();
      await sendMessage(
        token,
        chatId,
        "🆕 Started a fresh conversation — previous context cleared (still viewable in the web UI's session list).",
      );
      return true;
    case 'help':
      await sendMessage(token, chatId, HELP_TEXT);
      return true;
    default:
      await sendMessage(token, chatId, `Unknown command: /${command}. Try /help.`);
      return true;
  }
}

// The Telegram session is a single, indefinitely long-lived conversation
// (unlike the web UI, there's no "start a new chat" here) — without this it
// would grow forever and eventually exceed the model's context window,
// which Ollama handles by silently truncating from the front rather than
// erroring (see README's "Honest Context Window Display" section). Same
// summarize-older-into-a-dense-note mechanism as the web UI's Compact
// button (src/lib/compact.ts), just triggered by message count instead of a
// live num_ctx reading from /api/ps — this runs with no browser attached to
// supply one. KEEP_RECENT matches chat-panel.tsx's own constant so behavior
// stays familiar if you ever look at the two side by side.
const COMPACT_TRIGGER_COUNT = 16;
const KEEP_RECENT = 4;

async function maybeCompact(
  sessionId: string,
  model: string,
  base: string,
  token: string,
  chatId: number,
): Promise<ChatMessage[]> {
  const messages = getSession(sessionId)?.messages ?? [];
  if (messages.length <= COMPACT_TRIGGER_COUNT) return messages;

  const older = messages.slice(0, -KEEP_RECENT);
  const recent = messages.slice(-KEEP_RECENT);
  const transcript = older
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  if (transcript.length === 0) return messages;

  try {
    const summary = await compactMessages({ base, model, messages: transcript });
    const summaryMessage: ChatMessage = {
      id: safeUuid(),
      role: 'system',
      content: summary,
      createdAt: older[0]?.createdAt ?? Date.now(),
      model,
      sessionId,
    };
    const next = [summaryMessage, ...recent];
    updateSession(sessionId, { messages: next });
    await sendMessage(
      token,
      chatId,
      `🗜️ Compacted ${messages.length} older messages into a summary to keep things fast — nothing important should be lost.`,
    ).catch(() => {});
    return next;
  } catch (e) {
    // Not fatal — just means this turn sends the full (long) history like
    // before; the next turn tries again. Surfacing this to Telegram would be
    // noise for something that self-heals.
    console.error('[telegram-bridge] auto-compact failed, continuing uncompacted:', e);
    return messages;
  }
}

// Runs one generation turn end-to-end (job + status-message wiring +
// runGeneration + reading the settled result back from the DB) and returns
// the resulting message. Factored out so handleMessage can call it a second
// time for a corrective retry (see the reminder-verification check there)
// without duplicating the job/subscription plumbing — the typing indicator
// and status message are owned by the caller and span every attempt.
async function runTurn(
  base: string,
  model: string,
  sessionId: string,
  assistantMessageId: string,
  messages: ChatMessageIn[],
  memoryEnabled: boolean,
  token: string,
  chatId: number,
  statusMessageId: number | null,
): Promise<ChatMessage | undefined> {
  const job = createJob(assistantMessageId, { sessionId, column: 'A', model });
  const unsubscribe = subscribe(job.id, (event) => {
    if (statusMessageId == null) return;
    const e = event as {
      toolCall?: { name: string; arguments: unknown };
      queued?: { aheadCount: number };
    };
    if (e.toolCall) {
      editStatusMessage(
        token,
        chatId,
        statusMessageId,
        summarizeToolCall(e.toolCall.name, e.toolCall.arguments),
      );
    } else if (e.queued) {
      editStatusMessage(
        token,
        chatId,
        statusMessageId,
        `⏳ Waiting — ${e.queued.aheadCount} other request(s) already running for this model…`,
      );
    }
  });
  try {
    await runGeneration(job, {
      base,
      model,
      messages,
      think: false,
      options: undefined,
      toolsEnabled: true,
      memoryEnabled,
      searxngTemplate: null, // server-side default (SEARXNG_HOST env)
      // Settings → Tools individual toggles apply here too, not just the
      // web UI — a tool turned off globally stays off in Telegram as well.
      excludeTools: getGloballyDisabledToolNames(),
    });
  } finally {
    unsubscribe();
  }
  return getSession(sessionId)?.messages.find((m) => m.id === assistantMessageId);
}

async function handleMessage(
  token: string,
  model: string,
  chatId: number,
  text: string,
  sentAt: Date,
  images?: string[],
): Promise<void> {
  const base = resolveOllamaHostServer(); // no req — falls through to the active DB host
  if (!base) {
    await sendMessage(token, chatId, '[Error] No Ollama host configured.');
    return;
  }

  const sessionId = getOrCreateSessionId();
  const priorTurns = await maybeCompact(sessionId, model, base, token, chatId);
  const isFirstMessage = priorTurns.length === 0;

  const userMessage: ChatMessage = {
    id: safeUuid(),
    role: 'user',
    content: text,
    model,
    sessionId,
    createdAt: Date.now(),
    ...(images?.length ? { images } : {}),
  };
  const assistantMessage: ChatMessage = {
    id: safeUuid(),
    role: 'assistant',
    content: '',
    model,
    sessionId,
    createdAt: Date.now(),
  };
  upsertMessages(sessionId, [userMessage, assistantMessage]);
  if (isFirstMessage) updateSession(sessionId, { title: deriveSessionTitle(text) });

  // Same effective-memory resolution as POST /api/chat and the scheduler.
  const memoryEnabled =
    getSession(sessionId)?.memoryEnabled ??
    getSetting<{ memoryEnabled: boolean }>('memory')?.memoryEnabled ??
    true;

  // Wraps only what's SENT to the model, not the persisted/displayed
  // message — same split scheduler.ts uses for a fired reminder's prompt.
  // Without a stated reference time, the model has to call get_current_date
  // to work out something like "in 2 minutes", which reflects whenever that
  // tool call actually runs — after Ollama finishes loading the model on a
  // cold start, this can be tens of seconds to over a minute later than
  // when the message was actually sent, silently shifting any relative time
  // the model computes from it (observed live: asked about here after a
  // slow-feeling reminder).
  //
  // Given in LOCAL time (server timezone), not UTC — create_reminder's
  // whenISO is parsed by `new Date(...)` as local time when it has no "Z"/
  // offset (same convention get_current_date's own `time`/`date` fields
  // already used), and the model speaks times back to the user in local
  // form too. Handing it a UTC timestamp instead (an earlier version of
  // this did) got the arithmetic right but had the model repeat the UTC
  // digits as if they were local — 2 hours off from CEST (observed live).
  const promptForModel = `[Message sent at ${toLocalIsoLike(sentAt)} local time — use this as "now" for any relative time (e.g. "in 2 minutes", "tomorrow") and for any whenISO you compute, since real time may have passed since this was sent.]\n\n${text}`;

  const upstreamMessages: ChatMessageIn[] = [
    ...priorTurns
      .filter((m) => m.role !== 'assistant' || m.content)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images } : {}),
      })),
    { role: 'user' as const, content: promptForModel, ...(images?.length ? { images } : {}) },
  ];

  // Otherwise this is a black box until the final reply lands — Telegram's
  // native typing indicator plus a status message that tracks tool calls,
  // spanning every attempt below (including a corrective retry, if one
  // happens) rather than resetting per attempt.
  const stopTyping = startTypingIndicator(token, chatId);
  const statusMessageId = await sendStatusMessage(token, chatId, '⏳ Thinking…').catch(() => null);

  let result: ChatMessage | undefined;
  try {
    result = await runTurn(
      base,
      model,
      sessionId,
      assistantMessage.id,
      upstreamMessages,
      memoryEnabled,
      token,
      chatId,
      statusMessageId,
    );
  } catch (e) {
    // runGeneration's own catch-alls already settle the job and persist an
    // error message on every normal failure path — this only catches
    // something throwing past that, same last-resort net as api/chat/route.ts.
    stopTyping();
    if (statusMessageId != null) deleteMessage(token, chatId, statusMessageId);
    await sendMessage(
      token,
      chatId,
      `[Error] ${e instanceof Error ? e.message : 'Generation failed'}`,
    );
    return;
  }

  // A model can claim "I've set that up" in its final text without actually
  // having called create_reminder or create_recurring_task — the trace is
  // the only trustworthy signal (text-pattern-matching the reply would be
  // guessing at phrasing across languages/models). Only worth checking when
  // the user's *own* message looks schedule-shaped in the first place, so
  // an unrelated reply doesn't trigger a pointless retry. One corrective
  // retry with an explicit nudge; if that still doesn't produce a real tool
  // call, say so honestly instead of repeating a false confirmation
  // (observed live for both tools independently).
  let warning = '';
  if (SCHEDULE_INTENT_RE.test(text) && !hasAnySuccessfulSchedulingCall(result?.trace)) {
    if (statusMessageId != null) {
      editStatusMessage(
        token,
        chatId,
        statusMessageId,
        '🔁 Verifying that was actually scheduled…',
      );
    }
    const nudge: ChatMessageIn[] = [
      ...upstreamMessages,
      { role: 'assistant', content: result?.content ?? '' },
      {
        role: 'user',
        content:
          '[System: your previous reply claimed something was scheduled, cancelled, or changed, but you did not actually call the matching tool (create_reminder, create_recurring_task, or cancel_scheduled_task). Call the correct one now with the right arguments — do not just say you did it.]',
      },
    ];
    try {
      result = await runTurn(
        base,
        model,
        sessionId,
        assistantMessage.id,
        nudge,
        memoryEnabled,
        token,
        chatId,
        statusMessageId,
      );
    } catch (e) {
      console.error('[telegram-bridge] schedule-verification retry failed:', e);
    }
    if (!hasAnySuccessfulSchedulingCall(result?.trace)) {
      warning =
        "\n\n⚠️ I couldn't reliably confirm that actually went through — please check the Scheduled page in the app, or try again with a more explicit request.";
    }
  }

  stopTyping();
  if (statusMessageId != null) deleteMessage(token, chatId, statusMessageId);

  // A confabulated *list* of scheduled tasks is misinformation about the
  // user's own data, not just an unconfirmed action — replaced outright
  // with the real, deterministic result rather than merely flagged (see
  // listVerificationOverride's doc comment in schedule-verify.ts).
  const listOverride = listVerificationOverride(text, result?.trace);
  const finalContent = listOverride ?? (result?.content || '(no reply generated)') + warning;

  // runGeneration already persisted its own (pre-correction) content before
  // any of the checks above ever ran — unlike api/chat/route.ts, this file
  // doesn't go through runGeneration's postProcess hook (its own retry loop
  // needs the raw result mid-flight), so a listOverride or warning has to
  // be re-persisted by hand or the web UI's session history would keep
  // showing the uncorrected version forever.
  if (finalContent !== result?.content) {
    persistFinalAssistantMessage(sessionId, assistantMessage.id, {
      content: finalContent,
      trace: result?.trace,
      stats: result?.stats,
    });
  }
  // Same tap-to-cancel buttons as /tasks, attached whenever the reply IS a
  // tasks list (the override case) — whether the user asked via /tasks or
  // just asked in plain language ("what's scheduled?"), the result looks
  // and behaves the same.
  await sendMessage(token, chatId, finalContent, listOverride ? buildTasksKeyboard() : undefined);
}

// Cap on getUpdates retry backoff — an extended Telegram-side or network
// outage shouldn't turn into a request every few seconds forever.
const MAX_GETUPDATES_BACKOFF_MS = 60_000;

async function pollLoop(config: BridgeConfig): Promise<void> {
  const { token, allowedUserId, model, visionModel, whisperHost } = config;
  let offset = 0;
  // Tracks getUpdates failures in a row — drives both the backoff below and
  // a one-time "back online" notice once it recovers, so an outage while
  // you're away doesn't go unnoticed (you'd otherwise only find out the
  // bridge was down by trying to message it and getting silence).
  let consecutiveFailures = 0;

  for (;;) {
    let updates: TelegramUpdate[];
    try {
      updates = await callTelegram<TelegramUpdate[]>(token, 'getUpdates', {
        timeout: 25, // Telegram-side long-poll wait, keeps request volume low
        offset,
        allowed_updates: ['message', 'callback_query'],
      });
    } catch (e) {
      consecutiveFailures++;
      const backoffMs = Math.min(5000 * 2 ** (consecutiveFailures - 1), MAX_GETUPDATES_BACKOFF_MS);
      console.error(
        `[telegram-bridge] getUpdates failed (attempt ${consecutiveFailures}), retrying in ${Math.round(backoffMs / 1000)}s:`,
        e,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
      continue;
    }
    if (consecutiveFailures >= 3) {
      const chatId = Number(allowedUserId);
      if (Number.isFinite(chatId)) {
        await sendMessage(
          token,
          chatId,
          `✅ Reconnected to Telegram after ${consecutiveFailures} failed attempt(s).`,
        ).catch(() => {});
      }
    }
    consecutiveFailures = 0;

    for (const update of updates) {
      offset = update.update_id + 1;

      if (update.callback_query) {
        const cq = update.callback_query;
        // Same silent-drop policy as an unauthorized message — see this
        // file's top doc comment.
        if (!cq.from || String(cq.from.id) !== allowedUserId) continue;
        if (cq.data && cq.message) {
          try {
            await handleCallbackQuery(
              token,
              cq.message.chat.id,
              cq.message.message_id,
              cq.id,
              cq.data,
            );
          } catch (e) {
            console.error('[telegram-bridge] callback query handling failed:', e);
            await callTelegram(token, 'answerCallbackQuery', {
              callback_query_id: cq.id,
              text: 'Something went wrong.',
            }).catch(() => {});
          }
        }
        continue;
      }

      const msg = update.message;
      if (!msg?.from) continue;
      if (!msg.text && !msg.photo?.length && !msg.voice && !msg.document) continue; // text/photo/voice/document, v1

      // Logged before the allowlist check so "nothing arrived at all" and
      // "arrived but got dropped by the allowlist" are distinguishable —
      // console only, never sent back to Telegram (see this file's top doc
      // comment on why a rejected sender gets no reply).
      const receivedAtIso = msg.date ? new Date(msg.date * 1000).toISOString() : 'unknown time';
      console.log(
        `[telegram-bridge] update ${update.update_id} from user ${msg.from.id} at ${receivedAtIso}` +
          (msg.text
            ? `: ${JSON.stringify(msg.text.slice(0, 80))}`
            : msg.voice
              ? ' (voice)'
              : msg.document
                ? ` (document: ${msg.document.file_name ?? 'unnamed'})`
                : ' (photo)'),
      );

      // Silent drop — see this file's top doc comment for why no reply.
      if (String(msg.from.id) !== allowedUserId) continue;

      if (
        msg.text &&
        (await handleCommand(token, msg.chat.id, model, msg.text).catch((e) => {
          console.error('[telegram-bridge] command handling failed:', e);
          return true; // don't fall through to the model on a broken command reply
        }))
      ) {
        continue;
      }

      if (!model) {
        await sendMessage(
          token,
          msg.chat.id,
          '[Setup] TELEGRAM_MODEL is not set in .env.local — add it and restart the server.',
        ).catch(() => {});
        continue;
      }

      let effectiveModel = model;
      let images: string[] | undefined;
      if (msg.photo?.length) {
        const base = resolveOllamaHostServer();
        const candidate = visionModel ?? model;
        if (!base || !(await modelSupportsVision(base, candidate))) {
          await sendMessage(
            token,
            msg.chat.id,
            visionModel
              ? `[Setup] TELEGRAM_VISION_MODEL ("${visionModel}") doesn't report vision support in Ollama.`
              : `[Setup] TELEGRAM_MODEL ("${model}") can't see images. Set TELEGRAM_VISION_MODEL in .env.local to a vision-capable model (e.g. \`minicpm-v\`, \`gemma4\`) and restart the server.`,
          ).catch(() => {});
          continue;
        }
        effectiveModel = candidate;
        try {
          // Telegram's `photo` array is ordered smallest-to-largest — the
          // last entry is the highest resolution available.
          images = [await downloadTelegramPhoto(token, msg.photo[msg.photo.length - 1].file_id)];
        } catch (e) {
          console.error('[telegram-bridge] photo download failed:', e);
          await sendMessage(
            token,
            msg.chat.id,
            '[Error] Could not download that photo from Telegram.',
          ).catch(() => {});
          continue;
        }
      }
      let text =
        msg.text ??
        msg.caption ??
        (msg.document
          ? `📄 (document: ${msg.document.file_name ?? 'file'}, no caption)`
          : '📷 (photo, no caption)');
      const sentAt = msg.date ? new Date(msg.date * 1000) : new Date();

      if (msg.voice) {
        if (!whisperHost) {
          await sendMessage(
            token,
            msg.chat.id,
            '[Setup] WHISPER_HOST is not set in .env.local — voice messages need a running whisper.cpp server to transcribe. Text and photos still work.',
          ).catch(() => {});
          continue;
        }
        const statusId = await sendStatusMessage(
          token,
          msg.chat.id,
          '🎙️ Transcribing voice message…',
        ).catch(() => null);
        try {
          const bytes = await downloadTelegramFileBytes(token, msg.voice.file_id);
          text = await transcribeAudio(whisperHost, bytes);
        } catch (e) {
          console.error('[telegram-bridge] voice transcription failed:', e);
          if (statusId != null) deleteMessage(token, msg.chat.id, statusId);
          await sendMessage(
            token,
            msg.chat.id,
            '[Error] Could not transcribe that voice message.',
          ).catch(() => {});
          continue;
        }
        if (statusId != null) deleteMessage(token, msg.chat.id, statusId);
      }

      if (msg.document) {
        const fileName = msg.document.file_name ?? 'document';
        const statusId = await sendStatusMessage(
          token,
          msg.chat.id,
          `📄 Reading ${fileName}…`,
        ).catch(() => null);
        try {
          const bytes = await downloadTelegramFileBytes(token, msg.document.file_id);
          const content = await extractDocumentText(bytes, fileName, msg.document.mime_type);
          // The user's own caption (if any) becomes the actual instruction;
          // the document content follows as context, same "instruction
          // first, material after" shape a person would naturally use.
          text = `${msg.caption?.trim() || `Summarize this document (${fileName}).`}\n\n[Document: ${fileName}]\n${content}`;
        } catch (e) {
          console.error('[telegram-bridge] document extraction failed:', e);
          if (statusId != null) deleteMessage(token, msg.chat.id, statusId);
          await sendMessage(
            token,
            msg.chat.id,
            `[Error] ${e instanceof Error ? e.message : 'Could not read that document.'}`,
          ).catch(() => {});
          continue;
        }
        if (statusId != null) deleteMessage(token, msg.chat.id, statusId);
      }

      try {
        await handleMessage(token, effectiveModel, msg.chat.id, text, sentAt, images);
      } catch (e) {
        console.error('[telegram-bridge] handleMessage failed:', e);
        await sendMessage(
          token,
          msg.chat.id,
          '[Error] Something went wrong handling that message.',
        ).catch(() => {});
      }
    }
  }
}

// pollLoop's own `for (;;)` never returns normally — reaching either branch
// here means something escaped its internal try/catches (a bug, or a
// Telegram API shape this file doesn't handle yet). Without this wrapper
// that would silently end the bridge for good until the next full server
// restart, with nothing but one easy-to-miss console.error marking it —
// this restarts it instead, same backoff-free 5s pause getUpdates itself
// used to use, logged loudly either way.
async function runForever(config: BridgeConfig): Promise<void> {
  for (;;) {
    try {
      await pollLoop(config);
      console.error('[telegram-bridge] poll loop exited unexpectedly, restarting in 5s.');
    } catch (e) {
      console.error('[telegram-bridge] poll loop crashed, restarting in 5s:', e);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// Lets other server-side code (src/lib/scheduler.ts, for a recurring task or
// a fired reminder) push a message to the same single allowed user without
// needing an inbound message first — a private bot chat's chat_id is just
// the user's own id, no stored conversation context required. No-ops
// silently if the bridge isn't configured (TELEGRAM_BOT_TOKEN/
// TELEGRAM_ALLOWED_USER_ID unset) or the id isn't a valid number, so callers
// don't need to check "is Telegram set up" themselves.
export async function notifyTelegram(text: string): Promise<void> {
  const config = getConfig();
  if (!config) return;
  const chatId = Number(config.allowedUserId);
  if (!Number.isFinite(chatId)) return;
  await sendMessage(config.token, chatId, text).catch((e) => {
    console.error('[telegram-bridge] notifyTelegram failed:', e);
  });
}

// Guards against starting a second poll loop on Next.js dev's hot-reload —
// same reasoning as scheduler.ts's identical guard.
declare global {
  var __ollamaUiTelegramBridgeStarted: boolean | undefined;
}

export function startTelegramBridge(): void {
  if (globalThis.__ollamaUiTelegramBridgeStarted) return;
  const config = getConfig();
  if (!config) {
    console.log(
      '[telegram-bridge] TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_ID not set — skipping.',
    );
    return;
  }
  globalThis.__ollamaUiTelegramBridgeStarted = true;
  console.log('[telegram-bridge] started, polling for updates.');
  // Fire-and-forget — purely cosmetic (autocomplete in the Telegram client),
  // the commands work when typed either way.
  void callTelegram(config.token, 'setMyCommands', { commands: BOT_COMMANDS }).catch((e) =>
    console.error('[telegram-bridge] setMyCommands failed:', e),
  );
  void runForever(config);
}
