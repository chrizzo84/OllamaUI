import { describe, it, expect } from 'vitest';
import { replayToolTrace } from './generation-runner';
import type { TraceEvent } from '@/store/chat';

const toolEvent = (over: Partial<Extract<TraceEvent, { type: 'tool' }>> = {}) =>
  ({
    type: 'tool',
    id: 'i1',
    name: 'web_search',
    arguments: { query: 'solana' },
    result: { results: [] },
    ...over,
  }) as TraceEvent;

/*
Guards the precedent the model is shown for its own past turns: only the
final answer text is persisted as a message, so without this expansion the
history reads as "answered every lookup without ever calling a tool" — which
is what pushes a weak tool-caller to skip the tool and answer from memory.
*/
describe('replayToolTrace', () => {
  it('returns nothing when there is no trace at all', () => {
    expect(replayToolTrace(undefined)).toEqual([]);
    expect(replayToolTrace([])).toEqual([]);
  });

  it('ignores a trace that only holds thinking entries', () => {
    const trace: TraceEvent[] = [{ type: 'thinking', id: 't1', text: 'hmm' }];
    expect(replayToolTrace(trace)).toEqual([]);
  });

  it('rebuilds the assistant tool_calls message followed by one tool result', () => {
    const out = replayToolTrace([toolEvent()]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('assistant');
    expect(out[0].tool_calls).toEqual([
      { function: { name: 'web_search', arguments: { query: 'solana' } } },
    ]);
    expect(out[1]).toMatchObject({ role: 'tool', name: 'web_search' });
    expect(JSON.parse(out[1].content)).toEqual({ results: [] });
  });

  it('groups every call of one turn into a single assistant message', () => {
    const out = replayToolTrace([
      toolEvent({ id: 'a', name: 'get_current_date', arguments: {} }),
      toolEvent({ id: 'b', name: 'web_search' }),
    ]);
    expect(out[0].tool_calls).toHaveLength(2);
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(2);
  });

  it('replays a failed call as its error, not as a result', () => {
    const out = replayToolTrace([toolEvent({ result: undefined, error: 'backend down' })]);
    expect(JSON.parse(out[1].content)).toEqual({ error: 'backend down' });
  });

  it('represents a call that returned nothing as null rather than undefined', () => {
    const out = replayToolTrace([toolEvent({ result: undefined })]);
    expect(out[1].content).toBe('null');
  });

  it('truncates a large result so a long chat cannot be flooded by replays', () => {
    const out = replayToolTrace([toolEvent({ result: { blob: 'x'.repeat(5000) } })]);
    expect(out[1].content.length).toBeLessThan(700);
    expect(out[1].content.endsWith('… [truncated]')).toBe(true);
  });

  it('leaves a small result untouched', () => {
    const out = replayToolTrace([toolEvent({ result: { ok: true } })]);
    expect(out[1].content).toBe('{"ok":true}');
  });
});
