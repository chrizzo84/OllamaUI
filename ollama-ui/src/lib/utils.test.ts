import { describe, it, expect } from 'vitest';
import { cn, safeUuid, isThinkingModel, hasCapability, deriveSessionTitle } from './utils';

describe('cn', () => {
  it('merges conflicting tailwind classes, last one winning', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });

  it('drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, null, 'c')).toBe('a c');
  });
});

describe('safeUuid', () => {
  it('produces the RFC4122 v4 shape', () => {
    expect(safeUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('does not collide across many calls', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => safeUuid()));
    expect(ids.size).toBe(2000);
  });
});

describe('isThinkingModel', () => {
  it.each(['qwen3:8b', 'deepseek-r1:32b', 'phi4-reasoning', 'marco-o1', 'qwq:32b', 'QWEN3:latest'])(
    'recognises %s',
    (model) => {
      expect(isThinkingModel(model)).toBe(true);
    },
  );

  it.each(['llama3.2', 'mistral:7b', 'gemma3:12b', ''])('does not flag %s', (model) => {
    expect(isThinkingModel(model)).toBe(false);
  });
});

describe('hasCapability', () => {
  it('reports a present capability', () => {
    expect(hasCapability(['tools', 'vision'], 'tools')).toBe(true);
  });

  it('reports an absent capability', () => {
    expect(hasCapability(['vision'], 'tools')).toBe(false);
  });

  it('returns undefined ("unknown"), not false, when the list is unavailable', () => {
    // The distinction matters: an older Ollama that returns no capabilities
    // must not be read as "this model supports nothing".
    expect(hasCapability(undefined, 'tools')).toBeUndefined();
  });
});

describe('deriveSessionTitle', () => {
  it('uses the message as-is when short', () => {
    expect(deriveSessionTitle('Explain monads')).toBe('Explain monads');
  });

  it('collapses whitespace and newlines', () => {
    expect(deriveSessionTitle('  hello\n\n  world  ')).toBe('hello world');
  });

  it('strips surrounding quotes, including typographic ones', () => {
    expect(deriveSessionTitle('"quoted"')).toBe('quoted');
    expect(deriveSessionTitle('“smart quoted”')).toBe('smart quoted');
  });

  it('truncates with an ellipsis past 60 characters', () => {
    const title = deriveSessionTitle('x'.repeat(100));
    expect(title).toHaveLength(61); // 60 chars + the ellipsis
    expect(title.endsWith('…')).toBe(true);
  });

  it('does not leave a trailing space before the ellipsis', () => {
    const title = deriveSessionTitle('a'.repeat(59) + ' ' + 'b'.repeat(20));
    expect(title).not.toContain(' …');
  });

  it('falls back to "New chat" for empty or whitespace-only input', () => {
    expect(deriveSessionTitle('')).toBe('New chat');
    expect(deriveSessionTitle('   \n  ')).toBe('New chat');
    expect(deriveSessionTitle('""')).toBe('New chat');
  });
});
