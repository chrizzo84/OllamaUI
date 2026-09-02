import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateHost, getDefaultOllamaHost } from './env';

describe('validateHost', () => {
  it.each([
    'http://localhost:11434',
    'https://ollama.example.com',
    'http://192.168.1.5:11434',
    'http://127.0.0.1:11434/',
  ])('accepts %s', (host) => {
    expect(validateHost(host)).toBe(host);
  });

  it('trims surrounding whitespace', () => {
    expect(validateHost('  http://localhost:11434  ')).toBe('http://localhost:11434');
  });

  it.each([
    ['', 'empty'],
    ['localhost:11434', 'no scheme'],
    ['ftp://host/x', 'wrong scheme'],
    ['file:///etc/passwd', 'file scheme'],
    ['javascript:alert(1)', 'javascript scheme'],
    ['not a url', 'garbage'],
  ])('rejects %s (%s)', (host) => {
    expect(validateHost(host)).toBeNull();
  });
});

describe('getDefaultOllamaHost', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('prefers OLLAMA_HOST', () => {
    vi.stubEnv('OLLAMA_HOST', 'http://from-env:11434');
    expect(getDefaultOllamaHost()).toBe('http://from-env:11434');
  });

  it('falls back to NEXT_PUBLIC_OLLAMA_HOST', () => {
    vi.stubEnv('OLLAMA_HOST', '');
    vi.stubEnv('NEXT_PUBLIC_OLLAMA_HOST', 'http://public:11434');
    expect(getDefaultOllamaHost()).toBe('http://public:11434');
  });
});
