/*
The bot's slash commands (/info, /tasks, /new, /help) and the inline-keyboard
callbacks they produce.

Split out of telegram-bridge.ts so that adding a command is a change to one
small file rather than to the middle of the conversation engine. What is
*not* here, deliberately: anything that runs a generation. A command is a
direct answer about state the app already knows — which is exactly why it
can live apart from the model plumbing.
*/
import { listScheduledTasks, deleteScheduledTask } from '@/lib/db';
import { formatScheduledTasksList } from '@/lib/schedule-verify';
import { sendMessage, callTelegram, type InlineKeyboard } from '@/lib/telegram-api';
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { fetchModelCapabilities } from '@/lib/model-capabilities';
import { createNewTelegramSession } from '@/lib/telegram-session';
import telegramifyMarkdown from 'telegramify-markdown';

// Registered with Telegram once at startup (setMyCommands) so they show up
// as autocomplete in the client, in addition to just working when typed.
export const BOT_COMMANDS: { command: string; description: string }[] = [
  { command: 'info', description: 'Show the current model and what it can do' },
  { command: 'tasks', description: 'List scheduled tasks and pending reminders' },
  { command: 'new', description: 'Start a fresh conversation (clears context)' },
  { command: 'help', description: 'List available commands' },
];

export const HELP_TEXT = [
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
export function buildTasksKeyboard(): InlineKeyboard | undefined {
  const tasks = listScheduledTasks();
  if (tasks.length === 0) return undefined;
  return {
    inline_keyboard: tasks.map((t) => [
      { text: `❌ Cancel: ${t.name.slice(0, 40)}`, callback_data: `cancel_task:${t.id}` },
    ]),
  };
}

export async function handleTasksCommand(token: string, chatId: number): Promise<void> {
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
export async function handleCallbackQuery(
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
export async function handleCommand(
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
