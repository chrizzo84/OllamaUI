/*
What a model says it can do, straight from Ollama's /api/show.

Lives on its own because both the Telegram bridge (deciding whether a photo
can be sent to the configured model at all) and the /info command need it,
and neither should have to import the other to get it.
*/
export async function fetchModelCapabilities(
  base: string,
  model: string,
): Promise<string[] | null> {
  try {
    const res = await fetch(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.capabilities) ? data.capabilities : null;
  } catch {
    return null;
  }
}

export async function modelSupportsVision(base: string, model: string): Promise<boolean> {
  // Unknown (lookup failed) is treated as unsupported — safer than silently
  // sending an image to a model that might not be able to use it.
  return (await fetchModelCapabilities(base, model))?.includes('vision') ?? false;
}

// Local (server-timezone) date-time with no "Z"/offset suffix — the exact
// format create_reminder's whenISO expects (see its tool description in
// generation-runner.ts) and what get_current_date's own `date`/`time`
// fields already represent, so the model reasons in one consistent
// timezone instead of mixing this with a UTC timestamp.
