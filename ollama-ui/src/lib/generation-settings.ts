/*
Global generation defaults (Settings → Generation). Shared by the settings
API route, the client-side store, and every place that actually starts a
generation, so a default set here reaches the web chat, Telegram and
scheduled tasks alike.

This exists because the only context-window control used to be the per-model
`num_ctx` pill in the chat header: that value lives in the browser's
localStorage (numCtxByModel in store/prefs.ts), so it was lost on another
device, and it never applied to Telegram or the scheduler at all — both call
runGeneration with no options, leaving Ollama's own default. A model with a
large window and a big tool catalog (an MCP server can easily contribute tens
of thousands of tokens of definitions) therefore silently ran truncated
everywhere except the tab that had set the pill.

No server-only imports, safe to pull into client bundles too.
*/
import { DEFAULT_MIN_NUM_CTX } from '@/lib/utils';

export interface GenerationSettings {
  // Context window requested from Ollama when nothing more specific applies.
  defaultNumCtx: number;
}

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  defaultNumCtx: DEFAULT_MIN_NUM_CTX,
};

/*
Bounds on what may be stored. The low end is roughly where a tool-calling
system prompt stops fitting at all; the high end is past any local model's
window and is here to keep a mistyped value out of the database rather than
to express a real limit. A model's own maximum is enforced by Ollama, not
here — the same setting is shared by models with very different windows.
*/
export const MIN_NUM_CTX = 1024;
export const MAX_NUM_CTX = 1_048_576;

// Clamps rather than rejects an out-of-range number: this backs a slider and
// a number field, where "too big" means the user wants the maximum, not that
// they want their input thrown away. Non-numbers return null so callers can
// fall back to the current/default value.
export function parseNumCtx(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.min(MAX_NUM_CTX, Math.max(MIN_NUM_CTX, Math.round(value)));
}
