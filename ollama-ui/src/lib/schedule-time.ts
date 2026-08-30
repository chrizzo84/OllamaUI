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
