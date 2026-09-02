import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { compactMessages } from './compact';

const fetchMock = vi.fn();

const okWith = (content: unknown) =>
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ message: { content } }) });

const body = () => JSON.parse(fetchMock.mock.calls[0][1].body as string);

const MSGS = [
  { role: 'user' as const, content: 'How do I center a div?' },
  { role: 'assistant' as const, content: 'Use flexbox.' },
];

const call = (over: Partial<Parameters<typeof compactMessages>[0]> = {}) =>
  compactMessages({ base: 'http://ollama:11434', model: 'qwen3:8b', messages: MSGS, ...over });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('compactMessages', () => {
  it('returns the trimmed summary', async () => {
    okWith('  - user wants to center a div\n- answer: flexbox  ');
    expect(await call()).toBe('- user wants to center a div\n- answer: flexbox');
  });

  it('posts to the host chat endpoint', async () => {
    okWith('a summary long enough to pass the sanity check');
    await call();
    expect(fetchMock.mock.calls[0][0]).toBe('http://ollama:11434/api/chat');
  });

  it('sends a labelled transcript, not raw role names', async () => {
    okWith('a summary long enough to pass the sanity check');
    await call();
    const transcript = body().messages[1].content;
    expect(transcript).toContain('User: How do I center a div?');
    expect(transcript).toContain('Assistant: Use flexbox.');
  });

  it('labels a prior compacted summary as Context, not System', async () => {
    okWith('a summary long enough to pass the sanity check');
    await call({ messages: [{ role: 'system', content: 'earlier summary' }] });
    expect(body().messages[1].content).toContain('Context: earlier summary');
  });

  it('runs non-streaming with thinking disabled', async () => {
    okWith('a summary long enough to pass the sanity check');
    await call();
    expect(body().stream).toBe(false);
    expect(body().think).toBe(false);
  });

  it('passes num_ctx through when given', async () => {
    okWith('a summary long enough to pass the sanity check');
    await call({ numCtx: 32768 });
    expect(body().options.num_ctx).toBe(32768);
  });

  it('omits num_ctx when not given, leaving the server default', async () => {
    okWith('a summary long enough to pass the sanity check');
    await call();
    expect(body().options).not.toHaveProperty('num_ctx');
  });

  it('bounds the request with a timeout signal', async () => {
    okWith('a summary long enough to pass the sanity check');
    await call();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('throws the upstream body on a non-OK response', async () => {
    fetchMock.mockResolvedValue({ ok: false, text: async () => 'model not found' });
    await expect(call()).rejects.toThrow('model not found');
  });

  it('throws a generic error when the failure body is unreadable', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      text: async () => {
        throw new Error('stream closed');
      },
    });
    await expect(call()).rejects.toThrow('Compaction failed');
  });

  it('refuses a degenerate short summary rather than destroying history', async () => {
    // Seen in practice: a model replying with a single stray backtick.
    okWith('`');
    await expect(call()).rejects.toThrow(/suspiciously short/);
  });

  it('quotes the degenerate summary so the failure is diagnosable', async () => {
    okWith('nope');
    await expect(call()).rejects.toThrow(/"nope"/);
  });

  it('rejects an empty completion', async () => {
    okWith('');
    await expect(call()).rejects.toThrow('Empty summary response');
  });

  it('rejects a non-string completion', async () => {
    okWith({ unexpected: true });
    await expect(call()).rejects.toThrow('Empty summary response');
  });
});
