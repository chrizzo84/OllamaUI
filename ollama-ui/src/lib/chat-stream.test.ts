import { describe, it, expect, vi } from 'vitest';
import { consumeChatStream, readErrorMessage, type ChatStreamHandlers } from './chat-stream';

// Feeds the parser a stream split at arbitrary byte boundaries, which is what
// a real network connection does — the parser must not assume a chunk is a
// whole line.
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const ndjson = (...objs: unknown[]) => objs.map((o) => JSON.stringify(o) + '\n');

function spyHandlers(): { [K in keyof ChatStreamHandlers]-?: ReturnType<typeof vi.fn> } {
  return {
    onThinking: vi.fn(),
    onToken: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
    onSnapshot: vi.fn(),
    onQueued: vi.fn(),
  };
}

describe('consumeChatStream', () => {
  it('dispatches tokens in order', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(ndjson({ token: 'Hel' }, { token: 'lo' })), h);
    expect(h.onToken.mock.calls.map((c) => c[0])).toEqual(['Hel', 'lo']);
  });

  it('reassembles lines split across chunk boundaries', async () => {
    const h = spyHandlers();
    const line = JSON.stringify({ token: 'hello' }) + '\n';
    await consumeChatStream(streamOf([line.slice(0, 7), line.slice(7, 15), line.slice(15)]), h);
    expect(h.onToken).toHaveBeenCalledWith('hello');
  });

  it('processes a trailing line with no newline terminator', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf([JSON.stringify({ token: 'x' })]), h);
    expect(h.onToken).toHaveBeenCalledWith('x');
  });

  it('treats done as authoritative, not as a thinking delta', async () => {
    // Regression guard for the documented ordering hazard: the done event
    // carries the FULL thinking text, so checking `thinking` first would
    // double-append the reasoning.
    const h = spyHandlers();
    await consumeChatStream(
      streamOf(ndjson({ thinking: 'step ' }, { done: true, content: 'answer', thinking: 'step ' })),
      h,
    );
    expect(h.onThinking).toHaveBeenCalledTimes(1);
    expect(h.onDone).toHaveBeenCalledWith({
      content: 'answer',
      thinking: 'step ',
      stats: undefined,
    });
  });

  it('passes stats through on done', async () => {
    const h = spyHandlers();
    const stats = { promptTokens: 10, completionTokens: 20, tokensPerSecond: 5 };
    await consumeChatStream(streamOf(ndjson({ done: true, content: 'a', stats })), h);
    expect(h.onDone.mock.calls[0][0].stats).toEqual(stats);
  });

  it('defaults done content to an empty string when absent', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(ndjson({ done: true })), h);
    expect(h.onDone).toHaveBeenCalledWith({ content: '', thinking: undefined, stats: undefined });
  });

  it('emits a snapshot on reconnect', async () => {
    const h = spyHandlers();
    const snapshot = { content: 'so far', thinking: 'hm', trace: [] };
    await consumeChatStream(streamOf(ndjson({ snapshot }, { token: '!' })), h);
    expect(h.onSnapshot).toHaveBeenCalledWith(snapshot);
    expect(h.onToken).toHaveBeenCalledWith('!');
  });

  it('routes tool calls and results', async () => {
    const h = spyHandlers();
    const toolCall = { id: '1', name: 'calculator', arguments: { expression: '1+1' } };
    const toolResult = { id: '1', name: 'calculator', result: 2 };
    await consumeChatStream(streamOf(ndjson({ toolCall }, { toolResult })), h);
    expect(h.onToolCall).toHaveBeenCalledWith(toolCall);
    expect(h.onToolResult).toHaveBeenCalledWith(toolResult);
  });

  it('routes the queued heads-up', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(ndjson({ queued: { aheadCount: 2 } })), h);
    expect(h.onQueued).toHaveBeenCalledWith({ aheadCount: 2 });
  });

  it('routes errors and stops treating the line as anything else', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(ndjson({ error: 'upstream died', token: 'x' })), h);
    expect(h.onError).toHaveBeenCalledWith('upstream died');
    expect(h.onToken).not.toHaveBeenCalled();
  });

  it('skips malformed JSON lines instead of aborting the stream', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(['{not json}\n', ...ndjson({ token: 'ok' })]), h);
    expect(h.onToken).toHaveBeenCalledWith('ok');
    expect(h.onError).not.toHaveBeenCalled();
  });

  it('skips blank lines', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(['\n\n', ...ndjson({ token: 'ok' }), '\n']), h);
    expect(h.onToken).toHaveBeenCalledTimes(1);
  });

  it('ignores a control-only streamEnd line', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(ndjson({ streamEnd: true })), h);
    for (const fn of Object.values(h)) expect(fn).not.toHaveBeenCalled();
  });

  it('tolerates handlers being omitted entirely', async () => {
    await expect(
      consumeChatStream(streamOf(ndjson({ token: 'x' }, { done: true, content: 'x' })), {}),
    ).resolves.toBeUndefined();
  });

  it('returns immediately when the signal is already aborted', async () => {
    const h = spyHandlers();
    await consumeChatStream(streamOf(ndjson({ token: 'x' })), h, AbortSignal.abort());
    expect(h.onToken).not.toHaveBeenCalled();
  });
});

describe('readErrorMessage', () => {
  it('prefers the {error} JSON field', async () => {
    const res = new Response(JSON.stringify({ error: 'no host configured' }), { status: 428 });
    expect(await readErrorMessage(res)).toBe('no host configured');
  });

  it('falls back to raw text', async () => {
    expect(await readErrorMessage(new Response('boom', { status: 500 }))).toBe('boom');
  });

  it('truncates a very long body', async () => {
    const msg = await readErrorMessage(new Response('x'.repeat(2000), { status: 500 }));
    expect(msg).toHaveLength(500);
  });

  it('falls back to statusText on an empty body', async () => {
    const res = new Response('', { status: 503, statusText: 'Service Unavailable' });
    expect(await readErrorMessage(res)).toBe('Service Unavailable');
  });

  it('falls back to the status code when there is no statusText either', async () => {
    expect(await readErrorMessage(new Response('', { status: 500, statusText: '' }))).toBe(
      'Request failed (500)',
    );
  });

  it('ignores a JSON body whose error field is not a string', async () => {
    const body = JSON.stringify({ error: { code: 1 } });
    expect(await readErrorMessage(new Response(body, { status: 500 }))).toBe(body);
  });

  it('leaves the original response body readable', async () => {
    // readErrorMessage clones internally; a caller must still be able to
    // read the body afterwards.
    const res = new Response('boom', { status: 500 });
    await readErrorMessage(res);
    expect(await res.text()).toBe('boom');
  });
});
