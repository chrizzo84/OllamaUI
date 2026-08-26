// Core title-generation logic, extracted so it can be called both from the
// standalone /api/sessions/title route and directly (in-process) from the
// server-side chat-completion path in src/lib/chat-persistence.ts.

function sanitizeTitle(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  t = t.replace(/\s+/g, ' ');
  t = t.replace(/\.$/, '');
  if (t.length > 60) t = t.slice(0, 60).trim();
  return t;
}

// Non-streaming, best-effort short title generation for a new chat session.
// Callers should fall back to a truncated first message on any error/throw —
// this is a nice-to-have and must never block the chat itself.
export async function generateSessionTitle(
  base: string,
  model: string,
  firstUserMessage: string,
  firstAssistantMessage: string,
): Promise<string> {
  const prompt = `Conversation:\nUser: ${firstUserMessage.slice(0, 500)}\nAssistant: ${firstAssistantMessage.slice(0, 500)}\n\nReply with only a short 3-6 word title for this conversation. No quotes, no punctuation, no preamble.`;
  const upstream = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Without this, a hung Ollama host would leave the caller waiting
    // forever instead of falling back to a truncated title.
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: { num_predict: 20, temperature: 0.3 },
    }),
  });
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    throw new Error(txt || `Title generation failed (${upstream.status})`);
  }
  const data = await upstream.json();
  const raw = data?.message?.content;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new Error('Empty title response');
  }
  return sanitizeTitle(raw);
}
