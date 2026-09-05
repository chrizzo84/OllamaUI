/*
Server-side reader for the global generation defaults (see
src/lib/generation-settings.ts for the shared shape). Split out from that
file because it needs db.ts (node:sqlite), which can't go into a module
shared with client bundles — same split as tool-settings-server.ts.
*/
import { getSetting } from '@/lib/db';
import {
  DEFAULT_GENERATION_SETTINGS,
  parseNumCtx,
  type GenerationSettings,
} from '@/lib/generation-settings';

export const GENERATION_SETTINGS_KEY = 'generation';

export function getEffectiveGenerationSettings(): GenerationSettings {
  const stored = getSetting<Partial<GenerationSettings>>(GENERATION_SETTINGS_KEY);
  return {
    defaultNumCtx: parseNumCtx(stored?.defaultNumCtx) ?? DEFAULT_GENERATION_SETTINGS.defaultNumCtx,
  };
}

/*
Fills in the stored default context window on a generation's Ollama options,
unless the caller already asked for a specific one.

Deliberately non-destructive about an explicit `num_ctx`: the per-model pill
in the chat header is a considered choice for that one model and has to keep
winning over a global default. Everything else — Telegram, scheduled tasks,
and a web request that simply didn't say — picks the default up here, which
is the whole point of the setting being server-side.
*/
export function withDefaultNumCtx(options: unknown): Record<string, unknown> {
  const existing =
    options && typeof options === 'object' ? { ...(options as Record<string, unknown>) } : {};
  if (typeof existing.num_ctx === 'number' && Number.isFinite(existing.num_ctx)) return existing;
  existing.num_ctx = getEffectiveGenerationSettings().defaultNumCtx;
  return existing;
}
