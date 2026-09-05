import { create } from 'zustand';
import {
  DEFAULT_GENERATION_SETTINGS,
  parseNumCtx,
  type GenerationSettings,
} from '@/lib/generation-settings';

/*
Global generation defaults, persisted server-side (data/app.db, `settings`
table) rather than in localStorage — same pattern as store/tools.ts and
store/memory.ts, and the reason this setting exists at all: the per-model
num_ctx pill it backstops is browser-local and never reached Telegram or
scheduled tasks. See src/lib/generation-settings.ts.

Distinct from store/generation.ts, which tracks in-flight generations per
session/column and has nothing to do with configuration.
*/
interface GenerationSettingsState extends GenerationSettings {
  hydrated: boolean;
  setDefaultNumCtx(v: number): void;
  hydrate(): Promise<void>;
}

export const useGenerationSettingsStore = create<GenerationSettingsState>((set, get) => ({
  ...DEFAULT_GENERATION_SETTINGS,
  hydrated: false,
  setDefaultNumCtx: (v) => {
    const value = parseNumCtx(v);
    if (value === null) return;
    set({ defaultNumCtx: value });
    fetch('/api/settings/generation', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultNumCtx: value }),
    }).catch(() => {
      /* ignore */
    });
  },
  hydrate: async () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    try {
      const r = await fetch('/api/settings/generation', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      const value = parseNumCtx(data?.defaultNumCtx);
      if (value !== null) set({ defaultNumCtx: value });
    } catch {
      /* ignore */
    }
  },
}));
