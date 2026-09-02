/*
Everything that talks to Telegram's HTTP API, and nothing that decides what
to say.

Split out of telegram-bridge.ts, which had grown into a single file holding
the transport, the slash commands, the conversation logic and the polling
loop at once. Keeping the wire details here means the bridge reads as what
it is — receive an update, decide, reply — and that the awkward parts of
Telegram (the 4096-character cap, MarkdownV2 escaping, the two-step file
download) are stated once, in the place that owns them.
*/
import telegramifyMarkdown from 'telegramify-markdown';

const API_BASE = 'https://api.telegram.org';

// Telegram's real cap is 4096 UTF-16 code units; leave headroom rather than
// cut it exactly at the limit.
const TELEGRAM_MESSAGE_LIMIT = 3500;

export type InlineKeyboard = {
  inline_keyboard: { text: string; callback_data: string }[][];
};

export interface TelegramUpdate {
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

export async function callTelegram<T>(
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

export async function downloadTelegramFileBytes(token: string, fileId: string): Promise<Buffer> {
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
export async function downloadTelegramPhoto(token: string, fileId: string): Promise<string> {
  return (await downloadTelegramFileBytes(token, fileId)).toString('base64');
}

export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += TELEGRAM_MESSAGE_LIMIT) {
    chunks.push(text.slice(i, i + TELEGRAM_MESSAGE_LIMIT));
  }
  return chunks.length ? chunks : ['(empty reply)'];
}

// Reply markup (inline keyboard) is only attached to the final chunk — a
// multi-chunk reply is rare in practice (only a very long list/reply hits
// it), and Telegram only needs the buttons on one message anyway.

export async function sendChunks(
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
export async function sendMessage(
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

export async function sendStatusMessage(
  token: string,
  chatId: number,
  text: string,
): Promise<number> {
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
export function editStatusMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
): void {
  void callTelegram(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text: telegramifyMarkdown(text, 'escape'),
    parse_mode: 'MarkdownV2',
  }).catch(() => {});
}

export function deleteMessage(token: string, chatId: number, messageId: number): void {
  void callTelegram(token, 'deleteMessage', { chat_id: chatId, message_id: messageId }).catch(
    () => {},
  );
}

// Telegram's "X is typing…" indicator lasts ~5s per call and needs
// refreshing while a reply is still being generated — this is purely a
// native, wordless heads-up; the status message below carries the actual
// detail (which tool is running, whether the model is queued).
export function startTypingIndicator(token: string, chatId: number): () => void {
  const tick = () =>
    void callTelegram(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }).catch(
      () => {},
    );
  tick();
  const interval = setInterval(tick, 4000);
  return () => clearInterval(interval);
}
