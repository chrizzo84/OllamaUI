// Shared core of context compaction — summarizing older chat history into a
// dense note via the model itself — extracted so both the client-triggered
// endpoint (src/app/api/sessions/compact/route.ts, manual/auto-compact
// button in chat-panel.tsx) and a server-only caller with no HTTP request at
// hand (src/lib/telegram-bridge.ts's own auto-compact, since its long-lived
// session has no browser attached to click the button) share one prompt and
// one failure-mode definition instead of drifting apart.
export interface CompactMessageIn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const SUMMARY_SYSTEM_PROMPT = `You compress chat histories. Summarize the conversation below into a compact context note that lets an assistant seamlessly continue the conversation.

Rules:
- Keep all facts, decisions, constraints, names, numbers and open questions.
- Keep the user's goals and preferences.
- Drop greetings, filler and repetition.
- Write it as dense bullet points.
- Reply with ONLY the summary, no preamble.`;

// A real summary of a multi-message conversation is never this short — this
// catches degenerate completions (seen in practice: a model replying with a
// single stray backtick) that would otherwise silently replace older
// conversation with something useless, which is worse than just failing.
const MIN_SUMMARY_LENGTH = 20;

// Throws on any failure (bad host, upstream error, degenerate completion) —
// callers decide what "compaction failed" means for them (an HTTP error
// response for the route, falling back to uncompacted history for the
// Telegram bridge).
export async function compactMessages(params: {
  base: string;
  model: string;
  messages: CompactMessageIn[];
  numCtx?: number;
}): Promise<string> {
  const { base, model, messages, numCtx } = params;
  const transcript = messages
    .map(
      (m) =>
        `${m.role === 'assistant' ? 'Assistant' : m.role === 'system' ? 'Context' : 'User'}: ${m.content}`,
    )
    .join('\n\n');

  const upstream = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Without this, a hung Ollama host leaves compaction stuck forever.
    signal: AbortSignal.timeout(90_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: transcript },
      ],
      stream: false,
      think: false,
      options: { temperature: 0.2, num_predict: 1000, ...(numCtx ? { num_ctx: numCtx } : {}) },
    }),
  });
  if (!upstream.ok) {
    const txt = await upstream.text().catch(() => '');
    throw new Error(txt || 'Compaction failed');
  }
  const data = await upstream.json();
  const raw = data?.message?.content;
  const summary = typeof raw === 'string' ? raw.trim() : '';
  if (summary.length < MIN_SUMMARY_LENGTH) {
    throw new Error(
      summary
        ? `Model returned a suspiciously short summary ("${summary}") — refusing to use it`
        : 'Empty summary response',
    );
  }
  return summary;
}
