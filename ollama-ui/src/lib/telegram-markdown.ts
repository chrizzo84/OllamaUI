/**
 * Turning a model's Markdown into something Telegram actually renders.
 *
 * Telegram's MarkdownV2 is not Markdown. It has no tables, no headings, no
 * lists, no nested emphasis, and it rejects the whole message with
 * "Can't parse entities" if a single reserved character is unescaped or an
 * entity is left open. `telegramify-markdown` handles the escaping, and the
 * bridge used to hand its output straight to a blind 3500-character slicer.
 * That combination produced the three failures this module exists to fix:
 *
 *  1. **Everything arriving as raw Markdown.** Slicing the *rendered*
 *     MarkdownV2 at a fixed offset cuts entities and escape sequences in
 *     half (`*Punkt 36*` → `…*Punkt` + `36*…`). Telegram rejects the chunk,
 *     the bridge's catch-all resends the *entire* reply as plain text, and
 *     every `**bold**` shows up as literal asterisks. Sweeping the cut
 *     across a realistic reply, about a quarter of all multi-message replies
 *     landed on such a boundary — which is exactly why it looked random.
 *     Fixed by splitting the *source* Markdown at block boundaries and
 *     rendering each piece on its own, so every chunk is independently valid
 *     by construction.
 *  2. **Tables as unreadable pipe soup.** telegramify escapes a GFM table
 *     character by character (`\| gpt\-oss \| 20B \|`) and Telegram renders
 *     it in a proportional font, so nothing lines up. Tables are converted
 *     here instead: to an aligned monospace block when they're narrow enough
 *     for a phone, and to per-row `Key: value` records when they aren't.
 *  3. **Losing information that Telegram could have shown.** The code-fence
 *     language was dropped (no syntax highlighting), and `- [x]` task list
 *     markers vanished entirely, leaving a bullet that no longer said
 *     whether the item was done.
 *
 * Everything here is pure string work so it can be tested without a bot
 * token; the transport stays in telegram-api.ts.
 */
import telegramifyMarkdown from 'telegramify-markdown';

/**
 * Telegram's hard cap is 4096 UTF-16 code units per message. The budget is
 * on the *rendered* text, checked after rendering rather than guessed from
 * the source — escaping can nearly double a line of prose full of dots and
 * parentheses.
 */
const RENDERED_LIMIT = 3900;

/** Columns wider than this stop fitting a phone screen, where a monospace block wraps and destroys its own alignment. */
const MAX_TABLE_WIDTH = 62;

interface ParsedTable {
  header: string[];
  rows: string[][];
}

/**
 * Inline markup inside a table cell can't survive either target format (a
 * monospace block has no bold; a `Key: value` line puts its own emphasis on
 * the key), so the markers are removed rather than left to show up as
 * literal asterisks.
 */
function stripInlineMarkup(cell: string): string {
  return cell
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*\*([^*]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim();
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  // A pipe escaped inside a cell (`\|`) is content, not a column break.
  return s.split(/(?<!\\)\|/).map((c) => stripInlineMarkup(c.replace(/\\\|/g, '|')));
}

/** `| --- | :---: |` — the line that makes a block of pipes a table rather than prose. */
function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c.trim()));
}

function looksLikeTableRow(line: string): boolean {
  return line.includes('|') && line.trim().length > 0;
}

/**
 * Renders a table as a fixed-width block: the only way Telegram shows
 * columns that line up, since its monospace `pre` entity is the sole
 * fixed-width surface available.
 */
function renderAlignedTable(table: ParsedTable): string {
  const all = [table.header, ...table.rows];
  const widths = table.header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  const rule = widths.map((w) => '-'.repeat(w)).join('  ');
  return ['```', line(table.header), rule, ...table.rows.map(line), '```'].join('\n');
}

/**
 * The fallback for a table too wide to align on a phone: one record per row,
 * which reads fine in a proportional font and never wraps into nonsense.
 */
function renderRecordTable(table: ParsedTable): string {
  return table.rows
    .map((row) =>
      table.header
        .map((h, i) => (h ? `**${h}:** ${row[i] ?? ''}` : (row[i] ?? '')))
        .filter((l) => l.trim())
        .join('\n'),
    )
    .join('\n\n');
}

function renderTable(table: ParsedTable): string {
  const width =
    table.header.reduce((sum, _, i) => {
      const col = Math.max(...[table.header, ...table.rows].map((r) => (r[i] ?? '').length));
      return sum + col + 2;
    }, 0) - 2;
  return width <= MAX_TABLE_WIDTH ? renderAlignedTable(table) : renderRecordTable(table);
}

/**
 * Replaces every GFM table in `md` with a Telegram-renderable form. Code
 * fences are skipped — a table drawn inside a code block is already
 * monospace and is content, not markup.
 */
export function convertTables(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (
      !inFence &&
      looksLikeTableRow(line) &&
      i + 1 < lines.length &&
      isDelimiterRow(lines[i + 1])
    ) {
      const header = splitRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length && looksLikeTableRow(lines[j]); j++) {
        const cells = splitRow(lines[j]);
        // Ragged rows are normal in model output; pad rather than drop them.
        while (cells.length < header.length) cells.push('');
        rows.push(cells.slice(0, header.length));
      }
      out.push(renderTable({ header, rows }));
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * `- [x]` / `- [ ]` carry the entire point of a checklist and telegramify
 * drops them, leaving two bullets that look identical. Replaced with
 * characters that survive as text.
 */
export function convertTaskLists(md: string): string {
  return md.replace(
    /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]\s+/gm,
    (_m, bullet, mark) => `${bullet}${mark === ' ' ? '☐' : '☑'} `,
  );
}

interface Fence {
  lang: string;
  body: string;
}

/** MarkdownV2 `pre` blocks take only these two escapes — everything else is literal. */
function escapeCodeBody(body: string): string {
  return body.replace(/\\/g, '\\\\').replace(/`/g, '\\`');
}

function sanitizeLang(lang: string): string {
  return /^[A-Za-z0-9+#_.-]{1,20}$/.test(lang) ? lang : '';
}

/**
 * telegramify renders every fence as a bare ``` block, discarding the
 * language Telegram would happily use for syntax highlighting. So fences are
 * lifted out before rendering and put back afterwards — which also keeps
 * their contents away from the Markdown escaper entirely, since code is not
 * markup.
 */
function extractFences(md: string): { text: string; fences: Fence[]; token: string } {
  // Deterministic, but verified absent from the input so it can never
  // collide with something the model actually wrote.
  let token = 'TGFENCE';
  while (md.includes(token)) token += 'X';
  const fences: Fence[] = [];
  const text = md.replace(
    /^[ \t]*(```|~~~)[ \t]*([A-Za-z0-9+#_.-]*)[ \t]*\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm,
    (_m, _delim, lang: string, body: string) => {
      fences.push({ lang: sanitizeLang(lang), body: body.replace(/\n$/, '') });
      return `\n\n${token}${fences.length - 1}\n\n`;
    },
  );
  return { text, fences, token };
}

function restoreFences(rendered: string, fences: Fence[], token: string): string {
  return rendered.replace(new RegExp(`${token}(\\d+)`, 'g'), (_m, i: string) => {
    const fence = fences[Number(i)];
    if (!fence) return '';
    return `\`\`\`${fence.lang}\n${escapeCodeBody(fence.body)}\n\`\`\``;
  });
}

/**
 * Markdown in, Telegram MarkdownV2 out. The result is valid for a single
 * `sendMessage` as long as it fits the length cap — use `splitForTelegram`
 * rather than slicing this, which is what broke before.
 */
export function renderTelegramMarkdown(md: string): string {
  const prepared = convertTaskLists(convertTables(md));
  const { text, fences, token } = extractFences(prepared);
  const rendered = telegramifyMarkdown(text, 'escape');
  return restoreFences(rendered, fences, token).trim();
}

/**
 * Splits Markdown into blocks that can be rendered independently: a fenced
 * code block is one block, and everything else splits on blank lines.
 * Splitting here — before rendering — is the whole trick: each piece is a
 * complete Markdown document, so each rendered chunk is complete MarkdownV2,
 * with no entity or escape sequence straddling a boundary.
 */
function splitIntoBlocks(md: string): string[] {
  const blocks: string[] = [];
  const lines = md.split('\n');
  let current: string[] = [];
  let fenceDelim: string | null = null;
  const flush = () => {
    if (current.length) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of lines) {
    const fenceMatch = /^[ \t]*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (fenceDelim === null) {
        flush();
        fenceDelim = fenceMatch[1];
        current.push(line);
      } else if (line.trim().startsWith(fenceDelim)) {
        current.push(line);
        fenceDelim = null;
        flush();
      } else {
        current.push(line);
      }
      continue;
    }
    if (fenceDelim === null && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks.filter((b) => b.trim().length > 0);
}

/** Never cut between a surrogate pair — half an emoji is a broken character on the wire. */
function hardSplit(text: string, maxChars: number): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    let cut = maxChars;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1; // high surrogate would be orphaned
    // Prefer a word boundary when one is nearby.
    const space = rest.lastIndexOf(' ', cut);
    if (space > cut - 80 && space > 0) cut = space;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * Splits one oversized block. A code fence is reopened with the same
 * language in each piece, so a long program arrives as several complete code
 * blocks instead of one broken entity; prose splits by line, then by
 * characters if a single line is still too long.
 */
function splitOversizedBlock(block: string): string[] {
  const fence =
    /^[ \t]*(```|~~~)[ \t]*([A-Za-z0-9+#_.-]*)[ \t]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*$/.exec(block);
  if (fence) {
    const lang = sanitizeLang(fence[2]);
    const pieces: string[] = [];
    let buffer: string[] = [];
    const flush = () => {
      if (buffer.length) pieces.push(`\`\`\`${lang}\n${buffer.join('\n')}\n\`\`\``);
      buffer = [];
    };
    for (const line of fence[3].split('\n')) {
      const candidate = [...buffer, line].join('\n');
      // Leave room for the fence markers and the escaping inside the body.
      if (candidate.length > RENDERED_LIMIT - 200 && buffer.length) flush();
      if (line.length > RENDERED_LIMIT - 200) {
        flush();
        for (const part of hardSplit(line, RENDERED_LIMIT - 200))
          pieces.push(`\`\`\`${lang}\n${part}\n\`\`\``);
        continue;
      }
      buffer.push(line);
    }
    flush();
    return pieces;
  }

  // Rendered length is measured per line and summed, rather than
  // re-rendering the growing buffer on every line — that was quadratic, and
  // a long reply is exactly when this path runs.
  const pieces: string[] = [];
  let buffer: string[] = [];
  let bufferLen = 0;
  const flush = () => {
    if (buffer.length) pieces.push(buffer.join('\n'));
    buffer = [];
    bufferLen = 0;
  };
  for (const line of block.split('\n')) {
    const lineLen = renderTelegramMarkdown(line).length;
    if (bufferLen && bufferLen + lineLen + 1 > RENDERED_LIMIT) flush();
    if (lineLen > RENDERED_LIMIT) {
      flush();
      // A single paragraph longer than a whole message: split the source and
      // accept that the pieces are plain sentences.
      for (const part of hardSplit(line, Math.floor(RENDERED_LIMIT / 2))) pieces.push(part);
      continue;
    }
    buffer.push(line);
    bufferLen += lineLen + 1;
  }
  flush();
  return pieces;
}

/**
 * Markdown in, ready-to-send MarkdownV2 messages out — each one complete,
 * each one within Telegram's length cap. This replaces
 * `chunkText(telegramifyMarkdown(...))`, which produced chunks that were
 * individually invalid and cost the entire reply its formatting.
 */
export function splitForTelegram(md: string): string[] {
  const blocks = splitIntoBlocks(md);
  if (!blocks.length) return [];

  // Each block is rendered exactly once and the pieces are concatenated, so
  // a block's output is identical whether it ends up alone or grouped — and
  // grouping costs no extra rendering, which matters on the long replies
  // that reach this path in the first place.
  const messages: string[] = [];
  let group: string[] = [];
  let groupLen = 0;
  const flush = () => {
    if (group.length) messages.push(group.join('\n\n'));
    group = [];
    groupLen = 0;
  };

  for (const block of blocks) {
    const rendered = renderTelegramMarkdown(block);
    if (!rendered) continue;
    if (rendered.length > RENDERED_LIMIT) {
      flush();
      for (const piece of splitOversizedBlock(block)) {
        const out = renderTelegramMarkdown(piece);
        if (out) messages.push(out);
      }
      continue;
    }
    if (groupLen && groupLen + rendered.length + 2 > RENDERED_LIMIT) flush();
    group.push(rendered);
    groupLen += rendered.length + 2;
  }
  flush();
  return messages;
}

/**
 * Plain-text fallback chunking, for when Telegram rejects a rendered message
 * anyway. Splits on line boundaries where it can and never inside a
 * surrogate pair, so the fallback can't introduce a *new* failure.
 */
export function chunkPlainText(text: string, limit = RENDERED_LIMIT): string[] {
  if (!text.trim()) return ['(empty reply)'];
  const chunks: string[] = [];
  let buffer = '';
  for (const line of text.split('\n')) {
    if (buffer && buffer.length + line.length + 1 > limit) {
      chunks.push(buffer);
      buffer = '';
    }
    if (line.length > limit) {
      if (buffer) {
        chunks.push(buffer);
        buffer = '';
      }
      chunks.push(...hardSplit(line, limit));
      continue;
    }
    buffer = buffer ? `${buffer}\n${line}` : line;
  }
  if (buffer) chunks.push(buffer);
  return chunks.length ? chunks : ['(empty reply)'];
}
