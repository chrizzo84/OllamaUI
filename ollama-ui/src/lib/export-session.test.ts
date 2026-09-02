import { describe, it, expect } from 'vitest';
import { buildSessionMarkdown, slugifyFilename } from './export-session';
import type { ChatMessage } from '@/store/chat';

const msg = (role: ChatMessage['role'], content: string, model?: string): ChatMessage => ({
  id: Math.random().toString(36).slice(2),
  role,
  content,
  createdAt: 0,
  ...(model ? { model } : {}),
});

describe('buildSessionMarkdown', () => {
  it('renders a single-column conversation without column headers', () => {
    const md = buildSessionMarkdown('My chat', [msg('user', 'hi'), msg('assistant', 'hello')]);
    expect(md).toContain('# My chat');
    expect(md).toContain('### You\n\nhi');
    expect(md).toContain('### Assistant\n\nhello');
    expect(md).not.toContain('## Column A');
  });

  it('labels the assistant with its model when known', () => {
    const md = buildSessionMarkdown('t', [msg('assistant', 'hi', 'qwen3:8b')]);
    expect(md).toContain('### Assistant (qwen3:8b)');
  });

  it('adds column headers only when column B has messages', () => {
    const md = buildSessionMarkdown('t', [msg('user', 'a')], [msg('user', 'b')]);
    expect(md).toContain('## Column A');
    expect(md).toContain('## Column B');
  });

  it('treats an empty column B as single-column', () => {
    expect(buildSessionMarkdown('t', [msg('user', 'a')], [])).not.toContain('## Column A');
  });

  it('labels a compacted system message for what it is', () => {
    const md = buildSessionMarkdown('t', [msg('system', 'summary text')]);
    expect(md).toContain('### Compacted context summary\n\nsummary text');
  });

  it('marks an empty assistant reply rather than leaving a blank section', () => {
    expect(buildSessionMarkdown('t', [msg('assistant', '')])).toContain('_(no content)_');
  });

  it('handles an empty conversation', () => {
    const md = buildSessionMarkdown('Empty', []);
    expect(md).toContain('# Empty');
    expect(md).toContain('_Exported from Ollama UI on ');
  });
});

describe('slugifyFilename', () => {
  it.each([
    ['Hello World', 'hello-world'],
    ['Was ist 2+2?', 'was-ist-2-2'],
    ['  trim me  ', 'trim-me'],
    ['multiple---dashes', 'multiple-dashes'],
    ['UPPER', 'upper'],
  ])('slugifies %s', (input, expected) => {
    expect(slugifyFilename(input)).toBe(expected);
  });

  it('caps the length at 60 characters', () => {
    expect(slugifyFilename('a'.repeat(200))).toHaveLength(60);
  });

  it('never produces a leading or trailing dash', () => {
    expect(slugifyFilename('!!!edge!!!')).toBe('edge');
  });

  it('falls back to "chat" when nothing survives slugification', () => {
    expect(slugifyFilename('???')).toBe('chat');
    expect(slugifyFilename('')).toBe('chat');
    // Non-latin titles slugify to nothing, and an empty filename stem would
    // produce a file literally named ".md".
    expect(slugifyFilename('日本語のタイトル')).toBe('chat');
  });
});
