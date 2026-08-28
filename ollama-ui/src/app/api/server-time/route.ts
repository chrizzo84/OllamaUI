// Lets the UI show what the server's clock actually reads — relevant
// because Scheduled Tasks (src/lib/scheduler.ts) interpret time_of_day
// against server-local time, which can differ from the browser's own
// timezone (self-hosted on a different machine/region than the user).
export async function GET() {
  const now = new Date();
  return Response.json({
    epochMs: now.getTime(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}
