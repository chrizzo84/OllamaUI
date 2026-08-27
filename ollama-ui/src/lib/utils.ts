import { type ClassValue } from 'clsx';
import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Generate a RFC4122-ish UUID v4 with fallback if crypto.randomUUID is unavailable.
export function safeUuid() {
  const c: (Crypto & { randomUUID?: () => string }) | undefined =
    typeof crypto !== 'undefined' ? (crypto as Crypto & { randomUUID?: () => string }) : undefined;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* ignore */
    }
  }
  // Fallback: use crypto.getRandomValues if present
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    const buf = new Uint8Array(16);
    crypto.getRandomValues(buf);
    // Per RFC 4122 section 4.4
    buf[6] = (buf[6] & 0x0f) | 0x40; // version 4
    buf[8] = (buf[8] & 0x3f) | 0x80; // variant
    const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0'));
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }
  // Last resort (non-cryptographic)
  return 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Default floor for a model's context window (num_ctx) when the user hasn't
// set an explicit per-model override. Ollama's own server default is often
// just 4096, which reasoning models can burn through mid-thought and never
// reach an actual answer — never exceeds the model's real maximum.
export const DEFAULT_MIN_NUM_CTX = 16384;

// Known thinking/reasoning model name patterns
const THINKING_MODEL_PATTERNS = [/qwen3/i, /deepseek-r\d/i, /phi4-reasoning/i, /marco-o1/i, /qwq/i];

export function isThinkingModel(modelName: string): boolean {
  return THINKING_MODEL_PATTERNS.some((p) => p.test(modelName));
}

// Checks a model's declared capabilities (from Ollama's /api/show) for a
// given feature (e.g. "tools", "thinking"). Returns undefined when the
// capabilities list itself is unavailable (older Ollama, fetch failed),
// signalling "unknown" rather than falsely reporting unsupported.
export function hasCapability(
  capabilities: string[] | undefined,
  cap: string,
): boolean | undefined {
  return capabilities ? capabilities.includes(cap) : undefined;
}

const SESSION_TITLE_MAX_LEN = 60;

// A session's sidebar title, derived directly from the user's first message
// — no extra model call. Previously this ran a separate, non-streaming
// Ollama request just to summarize the first exchange into a title, which
// meant a session's title could fail to appear (or take a long time) for
// reasons entirely unrelated to the chat itself — most commonly, that
// request queuing behind another parallel chat using the same model. A
// plain truncation is instant, never fails, and needs nothing from Ollama.
export function deriveSessionTitle(firstUserMessage: string): string {
  let t = firstUserMessage.trim().replace(/\s+/g, ' ');
  t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '');
  if (!t) return 'New chat';
  if (t.length > SESSION_TITLE_MAX_LEN) {
    t = t.slice(0, SESSION_TITLE_MAX_LEN).trimEnd() + '…';
  }
  return t;
}
