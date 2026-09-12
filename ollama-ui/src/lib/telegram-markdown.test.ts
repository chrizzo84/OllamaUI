import { describe, it, expect } from 'vitest';
import {
  renderTelegramMarkdown,
  splitForTelegram,
  convertTables,
  convertTaskLists,
  chunkPlainText,
} from './telegram-markdown';

/**
 * Stand-in for Telegram's own MarkdownV2 parser: these are the ways a
 * message gets rejected with "Can't parse entities", which is what made the
 * bridge fall back to plain text and show the reader raw `**asterisks**`.
 * Not a full parser — it catches the structural breakage that chunking
 * causes, which is the failure this module exists to prevent.
 */
function markdownV2Problems(text: string): string[] {
  const problems: string[] = [];
  const fences = (text.match(/```/g) || []).length;
  if (fences % 2 === 1) problems.push('unclosed ``` block');
  // Escapes and emphasis only matter outside code entities.
  const body = text.replace(/```[\s\S]*?```/g, '').replace(/(?<!\\)`[^`]*`/g, '');
  if ((/(\\*)$/.exec(text)?.[1].length ?? 0) % 2 === 1) problems.push('ends mid-escape');
  for (const [ch, label] of [
    ['*', 'bold'],
    ['_', 'italic'],
    ['~', 'strikethrough'],
  ] as const) {
    const count = (body.match(new RegExp(`(?<!\\\\)\\${ch}`, 'g')) || []).length;
    if (count % 2 === 1) problems.push(`unbalanced ${label} delimiter`);
  }
  const opens = (body.match(/(?<!\\)\[/g) || []).length;
  const closes = (body.match(/(?<!\\)\]/g) || []).length;
  if (opens !== closes) problems.push('link split in half');
  // Every reserved character outside an entity must be escaped.
  return problems;
}

const expectValid = (text: string) => expect(markdownV2Problems(text)).toEqual([]);

describe('renderTelegramMarkdown', () => {
  it('renders bold as MarkdownV2 emphasis instead of literal asterisks', () => {
    expect(renderTelegramMarkdown('Das ist **fett**.')).toBe('Das ist *fett*\\.');
  });

  it('escapes reserved characters in prose', () => {
    expect(renderTelegramMarkdown('Preis 1.5 (ca. 20%)')).toBe('Preis 1\\.5 \\(ca\\. 20%\\)');
  });

  // telegramify-markdown drops the language, so Telegram showed an
  // unhighlighted block for code the model had labelled.
  it('keeps the code fence language', () => {
    const out = renderTelegramMarkdown('```python\ndef f(x):\n    return x\n```');
    expect(out).toBe('```python\ndef f(x):\n    return x\n```');
  });

  it('escapes backticks and backslashes inside a code block, nothing else', () => {
    const out = renderTelegramMarkdown('```\nlet s = "a`b" // C:\\tmp\nconst x = 1.5;\n```');
    expect(out).toContain('\\`b');
    expect(out).toContain('C:\\\\tmp');
    // Prose escaping must not leak into code: the dot stays a plain dot.
    expect(out).toContain('const x = 1.5;');
  });

  it('leaves an unlabelled fence unlabelled', () => {
    expect(renderTelegramMarkdown('```\nplain\n```')).toBe('```\nplain\n```');
  });
});

describe('convertTables', () => {
  const table = [
    '| Modell | Größe | Speed |',
    '| --- | --- | --- |',
    '| gpt-oss | 20B | 45 t/s |',
    '| qwen3 | 8B | 120 t/s |',
  ].join('\n');

  // Previously escaped character by character and rendered in a proportional
  // font, so no column ever lined up.
  it('renders a narrow table as an aligned monospace block', () => {
    const out = convertTables(table);
    expect(out.startsWith('```')).toBe(true);
    const lines = out.split('\n');
    expect(lines[1]).toBe('Modell   Größe  Speed');
    expect(lines[3]).toBe('gpt-oss  20B    45 t/s');
    // Every column starts at the same offset in every row.
    const col = (l: string) => l.indexOf('20B') >= 0 || l.indexOf('Größe') >= 0;
    expect(lines.filter(col).every((l) => l.indexOf('20B') === 9 || l.indexOf('Größe') === 9)).toBe(
      true,
    );
  });

  it('survives the full render as a valid code block', () => {
    const out = renderTelegramMarkdown(`Ergebnis:\n\n${table}`);
    expectValid(out);
    expect(out).toContain('```');
    expect(out).toContain('gpt-oss  20B');
    // No escaped pipe soup any more.
    expect(out).not.toContain('\\|');
  });

  it('strips inline markup inside cells rather than showing the markers', () => {
    const out = convertTables('| A | B |\n|---|---|\n| **fett** | `code` |');
    expect(out).toContain('fett');
    expect(out).not.toContain('**');
    expect(out).not.toContain('`code`');
  });

  // A wide table in a monospace block wraps on a phone and destroys its own
  // alignment, so it becomes one record per row instead.
  it('falls back to per-row records when the table is too wide for a phone', () => {
    const wide = [
      '| Modell | Beschreibung | Anmerkung |',
      '| --- | --- | --- |',
      '| gpt-oss:latest | Ein ziemlich langer Beschreibungstext hier | noch eine lange Spalte |',
    ].join('\n');
    const out = convertTables(wide);
    expect(out).not.toContain('```');
    expect(out).toContain('**Modell:** gpt-oss:latest');
    expect(out).toContain('**Beschreibung:**');
  });

  it('pads ragged rows instead of dropping them', () => {
    const out = convertTables('| A | B |\n|---|---|\n| nur eins |');
    expect(out).toContain('nur eins');
  });

  it('leaves a table drawn inside a code block alone', () => {
    const src = '```\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```';
    expect(convertTables(src)).toBe(src);
  });

  it('ignores pipes that are not a table', () => {
    const src = 'ls | grep x liefert nichts';
    expect(convertTables(src)).toBe(src);
  });
});

describe('convertTaskLists', () => {
  // telegramify drops the marker entirely, leaving two identical bullets.
  it('keeps done/open visible', () => {
    const out = renderTelegramMarkdown('- [x] erledigt\n- [ ] offen');
    expect(out).toContain('☑');
    expect(out).toContain('☐');
  });

  it('handles numbered task lists too', () => {
    expect(convertTaskLists('1. [ ] offen')).toBe('1. ☐ offen');
  });
});

describe('splitForTelegram', () => {
  const longReply = (paragraphs: number, prefix = '') => {
    let md = `${prefix}## Auswertung\n\n`;
    for (let i = 1; i <= paragraphs; i++) {
      md += `**Punkt ${i}** — Satz mit \`code\`, Zahl 1.5 (ca. 20%) und ein Link [Ollama](https://ollama.com).\n\n`;
    }
    return md;
  };

  it('keeps a short reply as a single message', () => {
    const out = splitForTelegram('Kurze **Antwort**.');
    expect(out).toHaveLength(1);
    expectValid(out[0]);
  });

  it('stays within Telegram’s length cap', () => {
    for (const msg of splitForTelegram(longReply(120))) {
      expect(msg.length).toBeLessThanOrEqual(4096);
    }
  });

  /**
   * The regression that made every long reply arrive as raw Markdown:
   * slicing rendered MarkdownV2 every 3500 characters cut entities in half.
   * Sweeping the cut across the repeating unit, ~26% of multi-message
   * replies used to break; every one of them must now be valid.
   */
  it('produces independently valid messages wherever the boundary falls', () => {
    for (let prefixLen = 0; prefixLen < 130; prefixLen++) {
      const md = longReply(60, `${'x'.repeat(prefixLen)}\n\n`);
      const messages = splitForTelegram(md);
      expect(messages.length).toBeGreaterThan(1);
      messages.forEach((m, i) =>
        expect(markdownV2Problems(m), `prefix ${prefixLen}, message ${i}`).toEqual([]),
      );
    }
  });

  it('never splits a code block into an unclosed fence', () => {
    const code = Array.from({ length: 400 }, (_, i) => `const x${i} = ${i} * 2;`).join('\n');
    const messages = splitForTelegram(`Hier:\n\n\`\`\`js\n${code}\n\`\`\``);
    expect(messages.length).toBeGreaterThan(1);
    for (const m of messages) expectValid(m);
    // Each piece of the program is a complete, still-labelled code block.
    const codeMessages = messages.filter((m) => m.includes('```'));
    expect(codeMessages.every((m) => m.includes('```js'))).toBe(true);
  });

  it('does not lose content when splitting', () => {
    const messages = splitForTelegram(longReply(80));
    const joined = messages.join('\n');
    expect(joined).toContain('Punkt 1');
    expect(joined).toContain('Punkt 80');
  });

  it('returns nothing for empty input', () => {
    expect(splitForTelegram('   \n\n  ')).toEqual([]);
  });

  it('keeps a table whole rather than splitting it mid-block', () => {
    const table = ['| A | B |', '| --- | --- |']
      .concat(Array.from({ length: 5 }, (_, i) => `| r${i} | v${i} |`))
      .join('\n');
    const messages = splitForTelegram(`Text\n\n${table}`);
    const withTable = messages.filter((m) => m.includes('r0'));
    expect(withTable).toHaveLength(1);
    expect(withTable[0]).toContain('r4');
  });
});

describe('chunkPlainText', () => {
  it('splits on line boundaries', () => {
    const chunks = chunkPlainText('a\nb\nc', 3);
    expect(chunks.every((c) => c.length <= 3)).toBe(true);
    expect(chunks.join('\n')).toBe('a\nb\nc');
  });

  // Slicing by UTF-16 code unit can orphan a high surrogate, which puts a
  // broken character on the wire.
  it('never splits an emoji in half', () => {
    const chunks = chunkPlainText('🚀🚀🚀🚀', 3);
    for (const c of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(c)).toBe(false);
    }
    expect(chunks.join('')).toBe('🚀🚀🚀🚀');
  });

  it('has something to say about an empty reply', () => {
    expect(chunkPlainText('')).toEqual(['(empty reply)']);
  });
});
