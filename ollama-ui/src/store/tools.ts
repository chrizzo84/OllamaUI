import { create } from 'zustand';
import {
  TOOL_KEYS,
  DEFAULT_TOOL_TOGGLES,
  anyToolEnabled,
  type ToolKey,
  type ToolToggles,
} from '@/lib/tool-settings';

// Global (not per-chat) tool-calling configuration — one toggle per tool
// (see src/lib/tool-settings.ts for the list), all on by default. Persisted
// server-side (data/app.db, `settings` table) instead of localStorage so
// it's shared across browsers/devices, same as the Ollama host list, and
// enforced server-side everywhere a generation actually runs (web chat,
// Telegram, scheduled tasks) — not just this store gating the web UI.
interface ToolsState extends ToolToggles {
  searxngTemplate: string;
  hydrated: boolean;
  setToolEnabled(key: ToolKey, v: boolean): void;
  setSearxngTemplate(v: string): void;
  hydrate(): Promise<void>;
}

// Only used once, to carry forward a value someone already set back when
// this lived in localStorage — removed after a successful one-time migration.
const LEGACY_KEY = 'ollama_ui_tools_v1';

async function putSettings(patch: Partial<ToolToggles & { searxngTemplate: string }>) {
  try {
    await fetch('/api/settings/tools', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch {
    /* ignore */
  }
}

export const useToolsStore = create<ToolsState>((set, get) => ({
  ...DEFAULT_TOOL_TOGGLES,
  searxngTemplate: '',
  hydrated: false,
  setToolEnabled: (key, v) => {
    set({ [key]: v } as Partial<ToolsState>);
    void putSettings({ [key]: v });
  },
  setSearxngTemplate: (v) => {
    set({ searxngTemplate: v });
    void putSettings({ searxngTemplate: v });
  },
  hydrate: async () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    try {
      const r = await fetch('/api/settings/tools', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      const toggles: ToolToggles = { ...DEFAULT_TOOL_TOGGLES };
      for (const key of TOOL_KEYS) {
        if (typeof data[key] === 'boolean') toggles[key] = data[key];
      }
      let searxngTemplate = typeof data.searxngTemplate === 'string' ? data.searxngTemplate : '';

      if (!data.exists && typeof window !== 'undefined') {
        // One-time migration: nothing stored server-side yet — carry
        // forward a legacy localStorage value if one exists, then persist
        // it server-side and stop touching localStorage from now on. The
        // old shape only had a single master switch, not per-tool — a
        // legacy "off" turns every tool off; "on"/missing keeps the new
        // all-on defaults.
        try {
          const raw = localStorage.getItem(LEGACY_KEY);
          if (raw) {
            const legacy = JSON.parse(raw) as Partial<{
              toolsEnabled: boolean;
              searxngTemplate: string;
            }>;
            if (legacy.toolsEnabled === false) {
              for (const key of TOOL_KEYS) toggles[key] = false;
            }
            if (typeof legacy.searxngTemplate === 'string' && legacy.searxngTemplate) {
              searxngTemplate = legacy.searxngTemplate;
            }
            await putSettings({ ...toggles, searxngTemplate });
            localStorage.removeItem(LEGACY_KEY);
          }
        } catch {
          /* ignore */
        }
      }

      set({ ...toggles, searxngTemplate });
    } catch {
      /* ignore */
    }
  },
}));

export function useAnyToolEnabled(): boolean {
  return useToolsStore((s) => anyToolEnabled(s));
}
