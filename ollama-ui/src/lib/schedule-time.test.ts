import { describe, it, expect } from 'vitest';
import { computeNextRunAt } from './schedule-time';

// All assertions build Dates with the local-time constructor on purpose:
// computeNextRunAt works in server-local time (setHours/getDay), which is
// exactly the semantic the Scheduled page promises the user.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

describe('computeNextRunAt', () => {
  it('returns today at the target time when that is still ahead', () => {
    // 2026-09-02 is a Wednesday.
    const from = at(2026, 9, 2, 8, 0);
    expect(computeNextRunAt('09:30', ALL_DAYS, from)).toBe(at(2026, 9, 2, 9, 30).getTime());
  });

  it('rolls over to tomorrow once the target time has passed today', () => {
    const from = at(2026, 9, 2, 10, 0);
    expect(computeNextRunAt('09:30', ALL_DAYS, from)).toBe(at(2026, 9, 3, 9, 30).getTime());
  });

  it('treats an exact match on `from` as already past (strictly future)', () => {
    // Guards the scheduler against re-running a task in the same tick it
    // just fired: next_run_at must never come back equal to the run time.
    const from = at(2026, 9, 2, 9, 30);
    expect(computeNextRunAt('09:30', ALL_DAYS, from)).toBe(at(2026, 9, 3, 9, 30).getTime());
  });

  it('skips to the next allowed weekday', () => {
    // From Wednesday, weekdays-only [Mon..Fri] with the time already gone.
    const from = at(2026, 9, 2, 23, 0);
    expect(computeNextRunAt('09:00', [1, 2, 3, 4, 5], from)).toBe(
      at(2026, 9, 3, 9, 0).getTime(), // Thursday
    );
  });

  it('wraps across the weekend to the following Monday', () => {
    // 2026-09-04 is a Friday; weekdays-only, time already gone.
    const from = at(2026, 9, 4, 23, 0);
    expect(computeNextRunAt('09:00', [1, 2, 3, 4, 5], from)).toBe(
      at(2026, 9, 7, 9, 0).getTime(), // Monday
    );
  });

  it('handles a single-day-per-week schedule a full week out', () => {
    // Wednesday, Wednesdays-only, time already gone -> next Wednesday.
    const from = at(2026, 9, 2, 12, 0);
    expect(computeNextRunAt('09:00', [3], from)).toBe(at(2026, 9, 9, 9, 0).getTime());
  });

  it('handles midnight as a target time', () => {
    const from = at(2026, 9, 2, 23, 30);
    expect(computeNextRunAt('00:00', ALL_DAYS, from)).toBe(at(2026, 9, 3, 0, 0).getTime());
  });

  it('crosses a month boundary', () => {
    const from = at(2026, 9, 30, 12, 0);
    expect(computeNextRunAt('08:00', ALL_DAYS, from)).toBe(at(2026, 10, 1, 8, 0).getTime());
  });

  it('crosses a year boundary', () => {
    const from = at(2026, 12, 31, 23, 0);
    expect(computeNextRunAt('07:00', ALL_DAYS, from)).toBe(at(2027, 1, 1, 7, 0).getTime());
  });

  it('falls back to +24h rather than throwing when no day is allowed', () => {
    // Documented "unreachable in practice" branch — callers enforce a
    // non-empty daysOfWeek, but a corrupted DB row must not kill the
    // scheduler tick for every other task.
    const from = at(2026, 9, 2, 12, 0);
    expect(computeNextRunAt('09:00', [], from)).toBe(from.getTime() + 24 * 60 * 60 * 1000);
  });

  it('always returns a strictly future timestamp for any valid input', () => {
    const from = at(2026, 9, 2, 14, 37);
    for (const day of ALL_DAYS) {
      for (const time of ['00:00', '09:30', '14:37', '23:59']) {
        expect(computeNextRunAt(time, [day], from)).toBeGreaterThan(from.getTime());
      }
    }
  });
});
