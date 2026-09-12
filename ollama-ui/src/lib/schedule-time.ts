// Extracted out of src/lib/scheduler.ts so src/lib/generation-runner.ts can
// use it too (the create_recurring_task tool needs to compute an initial
// next_run_at exactly like the Scheduled-page API route does) without a
// circular import — scheduler.ts already imports runGeneration from
// generation-runner.ts, so the reverse direction has to live somewhere
// neither of them owns.

// Finds the next moment (strictly after `from`) that matches `timeOfDay`
// ('HH:MM', server-local) and one of `daysOfWeek` (JS Date.getDay()
// convention: 0 = Sunday). Scans up to 7 days ahead, which always finds a
// match as long as daysOfWeek is non-empty (enforced by callers).
export function computeNextRunAt(timeOfDay: string, daysOfWeek: number[], from: Date): number {
  const [hh, mm] = timeOfDay.split(':').map(Number);
  for (let addDays = 0; addDays <= 7; addDays++) {
    const candidate = new Date(from);
    candidate.setDate(candidate.getDate() + addDays);
    candidate.setHours(hh, mm, 0, 0);
    if (candidate.getTime() <= from.getTime()) continue; // strictly future
    if (daysOfWeek.includes(candidate.getDay())) return candidate.getTime();
  }
  // Unreachable in practice (daysOfWeek is never empty), but keep the
  // caller alive rather than throwing if it somehow happens.
  return from.getTime() + 24 * 60 * 60 * 1000;
}

/**
 * The weekday name for a date handed to a model.
 *
 * Models cannot do calendar arithmetic and will confidently invent the
 * answer: asked about the forecast for 2026-09-13 — a Sunday — one announced
 * "Hier das Wetter für morgen (Freitag, 13.09.2026)". "Friday the 13th" is a
 * strong enough prior to beat the actual calendar, and the user has no way
 * to tell that the date came from a tool and the weekday from thin air.
 *
 * So every date that leaves a tool carries its weekday, and nothing has to be
 * derived. English names on purpose: translating one is something models do
 * reliably, counting days is not.
 *
 * A bare YYYY-MM-DD is a calendar day and is read in UTC — parsing it in the
 * server's zone would shift it a day west of Greenwich. A full timestamp is a
 * moment in time and is read in the server's zone, which is the one the
 * schedule was written in.
 */
export function weekdayOf(value: string | number | Date): string {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(`${value}T00:00:00Z`).toLocaleDateString('en-US', {
      weekday: 'long',
      timeZone: 'UTC',
    });
  }
  return new Date(value).toLocaleDateString('en-US', { weekday: 'long' });
}
