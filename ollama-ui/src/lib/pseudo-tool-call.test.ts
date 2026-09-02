import { describe, it, expect } from 'vitest';
import {
  looksLikePseudoToolCall,
  parsePseudoToolCall,
  renderPseudoToolCallAsMarkdown,
} from './pseudo-tool-call';

const SAMPLE = `<tool_call>
<function=web_write>
<parameter=path>
tetris.html
</parameter>
<parameter=file_text>
<!doctype html>
<h1>hi</h1>
</parameter>
</function>
</tool_call>`;

describe('looksLikePseudoToolCall', () => {
  it('detects the opening tag', () => {
    expect(looksLikePseudoToolCall(SAMPLE)).toBe(true);
  });

  it('tolerates leading whitespace', () => {
    expect(looksLikePseudoToolCall('\n\n  <tool_call>\n<function=x>')).toBe(true);
  });

  it('ignores an ordinary reply that merely mentions the tag', () => {
    expect(looksLikePseudoToolCall('The model emitted <tool_call> in its output')).toBe(false);
  });

  it('ignores empty content', () => {
    expect(looksLikePseudoToolCall('')).toBe(false);
  });
});

describe('parsePseudoToolCall', () => {
  it('extracts the function name and every parameter', () => {
    const parsed = parsePseudoToolCall(SAMPLE);
    expect(parsed?.functionName).toBe('web_write');
    expect(parsed?.parameters.path).toBe('tetris.html');
    expect(parsed?.parameters.file_text).toContain('<h1>hi</h1>');
  });

  it('returns null for text that is not a pseudo tool-call', () => {
    expect(parsePseudoToolCall('just a normal answer')).toBeNull();
  });

  it('returns null when the block has neither a function nor parameters', () => {
    expect(parsePseudoToolCall('<tool_call>\n</tool_call>')).toBeNull();
  });

  it('parses parameters even when the function tag is missing', () => {
    const parsed = parsePseudoToolCall('<tool_call>\n<parameter=q>\nhello\n</parameter>');
    expect(parsed?.functionName).toBeNull();
    expect(parsed?.parameters.q).toBe('hello');
  });

  it('keeps multi-line parameter bodies intact', () => {
    const parsed = parsePseudoToolCall(
      '<tool_call>\n<function=f>\n<parameter=code>\nline1\n\nline3\n</parameter>',
    );
    expect(parsed?.parameters.code).toBe('line1\n\nline3');
  });
});

describe('renderPseudoToolCallAsMarkdown', () => {
  it('renders the content parameter as a fenced block with a guessed language', () => {
    const md = renderPseudoToolCallAsMarkdown(parsePseudoToolCall(SAMPLE)!);
    expect(md).toContain('`web_write`');
    expect(md).toContain('**tetris.html**');
    expect(md).toContain('```html');
    expect(md).toContain('<h1>hi</h1>');
  });

  it.each([
    ['a.ts', 'typescript'],
    ['a.tsx', 'tsx'],
    ['a.py', 'python'],
    ['a.sh', 'bash'],
    ['a.yaml', 'yaml'],
    ['a.htm', 'html'],
  ])('maps %s to the %s fence', (path, lang) => {
    const md = renderPseudoToolCallAsMarkdown({
      functionName: 'f',
      parameters: { path, content: 'x' },
    });
    expect(md).toContain('```' + lang);
  });

  it('falls back to an unlabelled fence for an unknown extension', () => {
    const md = renderPseudoToolCallAsMarkdown({
      functionName: 'f',
      parameters: { path: 'a.zzz', content: 'x' },
    });
    expect(md).toContain('```\nx\n```');
  });

  it('dumps every parameter when none of them look like content', () => {
    const md = renderPseudoToolCallAsMarkdown({
      functionName: 'search',
      parameters: { query: 'weather', limit: '5' },
    });
    expect(md).toContain('**query**');
    expect(md).toContain('**limit**');
  });

  it('renders just the note when there are no parameters at all', () => {
    const md = renderPseudoToolCallAsMarkdown({ functionName: 'noop', parameters: {} });
    expect(md).toContain('`noop`');
    expect(md).not.toContain('```');
  });

  it('says "unknown" when the function name could not be parsed', () => {
    const md = renderPseudoToolCallAsMarkdown({ functionName: null, parameters: { a: 'b' } });
    expect(md).toContain('`unknown`');
  });
});
