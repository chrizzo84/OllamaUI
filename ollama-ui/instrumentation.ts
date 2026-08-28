// Next.js runs `register()` once when the server process starts — the
// standard hook for background work that shouldn't wait for a first HTTP
// request (see src/lib/db.ts's doc comment for why DB access itself stays
// lazy instead; the scheduler is the opposite case: it needs to start
// proactively so a task can fire even if nobody ever loads a page).
export async function register() {
  // Guards against running under the Edge runtime, where `node:sqlite`
  // (used transitively by the scheduler via src/lib/db.ts) isn't available —
  // same constraint src/lib/db.ts's own doc comment calls out.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { startScheduler } = await import('@/lib/scheduler');
    startScheduler();
  }
}
