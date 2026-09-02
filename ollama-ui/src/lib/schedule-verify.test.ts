import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TraceEvent } from '@/store/chat';

// db.ts opens a real SQLite file on first access, so it is mocked out
// wholesale here — these tests are about the verification logic, not
// persistence.
const listScheduledTasks = vi.fn();
vi.mock('@/lib/db', () => ({ listScheduledTasks: () => listScheduledTasks() }));

const {
  SCHEDULE_INTENT_RE,
  LIST_INTENT_RE,
  hasSuccessfulToolCall,
  hasAnySuccessfulSchedulingCall,
  scheduleVerificationWarning,
  listVerificationOverride,
  formatScheduledTasksList,
} = await import('./schedule-verify');

const toolOk = (name: string): TraceEvent => ({ type: 'tool', name }) as TraceEvent;
const toolErr = (name: string): TraceEvent => ({ type: 'tool', name, error: 'boom' }) as TraceEvent;

beforeEach(() => {
  listScheduledTasks.mockReset();
  listScheduledTasks.mockReturnValue([]);
});

describe('SCHEDULE_INTENT_RE', () => {
  it.each([
    'erinnere mich morgen um 9',
    'remind me tomorrow',
    'jeden Morgen um 8 das Wetter',
    'täglich um 7 Uhr',
    'every morning at 8',
    'every weekday at noon',
    'wöchentlich zusammenfassen',
    'storniere die tägliche Wettervorhersage',
    'set up a recurring digest',
  ])('matches %s', (text) => {
    expect(SCHEDULE_INTENT_RE.test(text)).toBe(true);
  });

  it.each(['what is the capital of France', 'schreib mir ein Gedicht', 'fix this bug'])(
    'does not match %s',
    (text) => {
      expect(SCHEDULE_INTENT_RE.test(text)).toBe(false);
    },
  );
});

describe('LIST_INTENT_RE', () => {
  it.each([
    'was ist geplant?',
    'welche Erinnerungen habe ich?',
    'meine Aufgaben bitte',
    'what is scheduled?',
    'list my reminders',
    'show my tasks',
  ])('matches %s', (text) => {
    expect(LIST_INTENT_RE.test(text)).toBe(true);
  });

  it.each(['erinnere mich morgen um 9', 'wie ist das Wetter?'])('does not match %s', (text) => {
    expect(LIST_INTENT_RE.test(text)).toBe(false);
  });
});

describe('hasSuccessfulToolCall', () => {
  it('finds a successful call', () => {
    expect(hasSuccessfulToolCall([toolOk('create_reminder')], 'create_reminder')).toBe(true);
  });

  it('ignores a failed call of the same tool', () => {
    expect(hasSuccessfulToolCall([toolErr('create_reminder')], 'create_reminder')).toBe(false);
  });

  it('ignores a different tool', () => {
    expect(hasSuccessfulToolCall([toolOk('web_search')], 'create_reminder')).toBe(false);
  });

  it('ignores non-tool trace events', () => {
    expect(
      hasSuccessfulToolCall([{ type: 'thinking', text: 'hm' } as unknown as TraceEvent], 'x'),
    ).toBe(false);
  });

  it('handles a missing trace', () => {
    expect(hasSuccessfulToolCall(undefined, 'create_reminder')).toBe(false);
  });
});

describe('hasAnySuccessfulSchedulingCall', () => {
  it.each(['create_reminder', 'create_recurring_task', 'cancel_scheduled_task'])(
    'counts %s as scheduling',
    (name) => {
      expect(hasAnySuccessfulSchedulingCall([toolOk(name)])).toBe(true);
    },
  );

  it('does not count list_scheduled_tasks', () => {
    expect(hasAnySuccessfulSchedulingCall([toolOk('list_scheduled_tasks')])).toBe(false);
  });
});

describe('scheduleVerificationWarning', () => {
  it('warns when the ask looked schedule-shaped but nothing was called', () => {
    expect(scheduleVerificationWarning('erinnere mich morgen um 9', [])).toMatch(
      /couldn't confirm/,
    );
  });

  it('warns when every scheduling attempt failed', () => {
    expect(scheduleVerificationWarning('remind me tomorrow', [toolErr('create_reminder')])).toMatch(
      /couldn't confirm/,
    );
  });

  it('stays silent when the tool actually succeeded', () => {
    expect(
      scheduleVerificationWarning('remind me tomorrow', [toolOk('create_reminder')]),
    ).toBeNull();
  });

  it('stays silent for a cancellation that succeeded', () => {
    // Regression: a successful cancel used to trip the warning because only
    // the two create_* tools counted as success.
    expect(
      scheduleVerificationWarning('storniere die tägliche Wettervorhersage', [
        toolOk('cancel_scheduled_task'),
      ]),
    ).toBeNull();
  });

  it('stays silent when the message was never schedule-shaped', () => {
    expect(scheduleVerificationWarning('what is 2+2?', [])).toBeNull();
  });
});

describe('formatScheduledTasksList', () => {
  it('reports an empty schedule', () => {
    expect(formatScheduledTasksList()).toBe('Nothing currently scheduled.');
  });

  it('formats a recurring task with sorted day labels', () => {
    listScheduledTasks.mockReturnValue([
      { name: 'Weather', recurring: true, timeOfDay: '08:00', daysOfWeek: [5, 1, 3] },
    ]);
    const out = formatScheduledTasksList();
    expect(out).toContain('🔁 Weather — 08:00 on Mon, Wed, Fri');
  });

  it('does not mutate the caller-supplied daysOfWeek array while sorting', () => {
    const days = [5, 1, 3];
    listScheduledTasks.mockReturnValue([
      { name: 'Weather', recurring: true, timeOfDay: '08:00', daysOfWeek: days },
    ]);
    formatScheduledTasksList();
    expect(days).toEqual([5, 1, 3]);
  });

  it('formats a one-off reminder with its absolute time', () => {
    const when = new Date(2026, 8, 3, 9, 0).getTime();
    listScheduledTasks.mockReturnValue([
      {
        name: 'Call dentist',
        recurring: false,
        timeOfDay: '09:00',
        daysOfWeek: [],
        nextRunAt: when,
      },
    ]);
    const out = formatScheduledTasksList();
    expect(out).toContain('⏰ Call dentist');
    expect(out).toContain(new Date(when).toLocaleString());
  });

  it('degrades gracefully when a one-off has no next run time', () => {
    listScheduledTasks.mockReturnValue([
      { name: 'Orphan', recurring: false, timeOfDay: '09:00', daysOfWeek: [], nextRunAt: null },
    ]);
    expect(formatScheduledTasksList()).toContain('unknown time');
  });
});

describe('listVerificationOverride', () => {
  it('replaces a confabulated list with the real one', () => {
    listScheduledTasks.mockReturnValue([
      { name: 'Weather', recurring: true, timeOfDay: '08:00', daysOfWeek: [1] },
    ]);
    const out = listVerificationOverride('what is scheduled?', []);
    expect(out).toContain('🔁 Weather');
  });

  it('returns the real empty state rather than letting an invented list stand', () => {
    expect(listVerificationOverride('welche Erinnerungen habe ich?', [])).toBe(
      'Nothing currently scheduled.',
    );
  });

  it('leaves the reply alone when the tool really ran', () => {
    expect(
      listVerificationOverride('what is scheduled?', [toolOk('list_scheduled_tasks')]),
    ).toBeNull();
  });

  it('leaves the reply alone when the user never asked for a list', () => {
    expect(listVerificationOverride('remind me tomorrow', [])).toBeNull();
  });
});
