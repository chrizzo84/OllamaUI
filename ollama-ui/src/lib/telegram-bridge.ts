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
import { createSession, getSession, getSetting, setSetting, updateSession } from '@/lib/db';
import { upsertMessages } from '@/lib/chat-persistence';
import { createJob, subscribe } from '@/lib/generation-jobs';
import { runGeneration, type ChatMessageIn } from '@/lib/generation-runner';
import { compactMessages } from '@/lib/compact';
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
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    from?: { id: number };
    chat: { id: number };
    text?: string;
    caption?: string;
    // Telegram sends one entry per available resolution, smallest first —
    // the last one is the largest/highest-quality available.
    photo?: { file_id: string }[];
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

// Downloads a Telegram-hosted photo and returns it as raw base64 (no
// `data:...;base64,` prefix), matching ChatMessage.images' documented shape
// (src/store/chat.ts) — the same format the web UI's Attach button produces,
// so both paths feed the model identically.
async function downloadTelegramPhoto(token: string, fileId: string): Promise<string> {
  const file = await callTelegram<{ file_path: string }>(token, 'getFile', { file_id: fileId });
  const res = await fetch(`${API_BASE}/file/bot${token}/${file.file_path}`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Telegram file download failed: ${res.status}`);
  const bytes = await res.arrayBuffer();
  return Buffer.from(bytes).toString('base64');
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

function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(i, i + TELEGRAM_MESSAGE_LIMIT));
  }
  return chunks.length ? chunks : ['(empty reply)'];
}

// Sends `text` as Telegram MarkdownV2 (so the model's normal **bold**/`code`/
// lists render instead of showing as raw asterisks/backticks). LLM markdown
// isn't guaranteed to be valid MarkdownV2 — telegramify-markdown handles the
// escaping, but a chunk boundary can still split an entity in two on a long,
// multi-chunk reply — so on any failure this resends the whole thing as
// plain text instead. A rare double-send (some chunks already went out
// formatted) is the accepted cost of never silently dropping a reply.
async function sendMessage(token: string, chatId: number, text: string): Promise<void> {
  try {
    for (const chunk of chunkText(telegramifyMarkdown(text, 'escape'))) {
      await callTelegram(token, 'sendMessage', {
        chat_id: chatId,
        text: chunk,
        parse_mode: 'MarkdownV2',
      });
    }
  } catch {
    for (const chunk of chunkText(text)) {
      await callTelegram(token, 'sendMessage', { chat_id: chatId, text: chunk });
    }
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
  { command: 'new', description: 'Start a fresh conversation (clears context)' },
  { command: 'help', description: 'List available commands' },
];

const HELP_TEXT = [
  '**Commands:**',
  '/info — show the current model and what it can do',
  '/new — start a fresh conversation (clears context)',
  '/help — show this message',
  '',
  'Anything else is sent straight to the model — text, or a photo for vision.',
].join('\n');

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
        `👋 Connected. Send a message to chat, or a photo for vision. Commands: /info, /new, /help.`,
      );
      return true;
    case 'info':
      await handleInfoCommand(token, chatId, model);
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

async function handleMessage(
  token: string,
  model: string,
  chatId: number,
  text: string,
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

  const upstreamMessages: ChatMessageIn[] = [
    ...priorTurns
      .filter((m) => m.role !== 'assistant' || m.content)
      .map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images } : {}),
      })),
    { role: 'user' as const, content: text, ...(images?.length ? { images } : {}) },
  ];

  const job = createJob(assistantMessage.id, { sessionId, column: 'A', model });

  // Otherwise this is a black box until the final reply lands — Telegram's
  // native typing indicator plus a status message that tracks tool calls
  // (subscribing before runGeneration starts, same ordering requirement as
  // api/chat/route.ts's event stream, so no event is ever missed).
  const stopTyping = startTypingIndicator(token, chatId);
  const statusMessageId = await sendStatusMessage(token, chatId, '⏳ Thinking…').catch(() => null);
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
      messages: upstreamMessages,
      think: false,
      options: undefined,
      toolsEnabled: true,
      memoryEnabled,
      searxngTemplate: null, // server-side default (SEARXNG_HOST env)
    });
  } catch (e) {
    // runGeneration's own catch-alls already settle the job and persist an
    // error message on every normal failure path — this only catches
    // something throwing past that, same last-resort net as api/chat/route.ts.
    await sendMessage(
      token,
      chatId,
      `[Error] ${e instanceof Error ? e.message : 'Generation failed'}`,
    );
    return;
  } finally {
    stopTyping();
    unsubscribe();
    if (statusMessageId != null) deleteMessage(token, chatId, statusMessageId);
  }

  const finalContent =
    getSession(sessionId)?.messages.find((m) => m.id === assistantMessage.id)?.content ||
    '(no reply generated)';
  await sendMessage(token, chatId, finalContent);
}

async function pollLoop(config: BridgeConfig): Promise<void> {
  const { token, allowedUserId, model, visionModel } = config;
  let offset = 0;

  for (;;) {
    let updates: TelegramUpdate[];
    try {
      updates = await callTelegram<TelegramUpdate[]>(token, 'getUpdates', {
        timeout: 25, // Telegram-side long-poll wait, keeps request volume low
        offset,
        allowed_updates: ['message'],
      });
    } catch (e) {
      console.error('[telegram-bridge] getUpdates failed, retrying in 5s:', e);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    for (const update of updates) {
      offset = update.update_id + 1;
      const msg = update.message;
      if (!msg?.from) continue;
      if (!msg.text && !msg.photo?.length) continue; // only text/photo messages, v1
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
      const text = msg.text ?? msg.caption ?? '📷 (photo, no caption)';
      try {
        await handleMessage(token, effectiveModel, msg.chat.id, text, images);
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
  void pollLoop(config).catch((e) => console.error('[telegram-bridge] poll loop crashed:', e));
}
