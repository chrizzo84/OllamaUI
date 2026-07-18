import { create } from 'zustand';

// Global (not per-chat) tool-calling configuration. A single master switch
// gates every tool the model may call (web_search, get_current_date, ...);
// there is no per-tool toggle since the individual tools are cheap/safe to
// expose together. Persisted server-side (data/app.db, `settings` table)
// instead of localStorage so it's shared across browsers/devices, same as
// the Ollama host list.
interface ToolsState {
  toolsEnabled: boolean;
  searxngTemplate: string;
  hydrated: boolean;
  setToolsEnabled(v: boolean): void;
  setSearxngTemplate(v: string): void;
  hydrate(): Promise<void>;
}

// Only used once, to carry forward a value someone already set back when
// this lived in localStorage — removed after a successful one-time migration.
const LEGACY_KEY = 'ollama_ui_tools_v1';

async function putSettings(patch: Partial<Pick<ToolsState, 'toolsEnabled' | 'searxngTemplate'>>) {
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
  toolsEnabled: false,
  searxngTemplate: '',
  hydrated: false,
  setToolsEnabled: (v) => {
    set({ toolsEnabled: v });
    void putSettings({ toolsEnabled: v });
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
      let toolsEnabled = !!data.toolsEnabled;
      let searxngTemplate = typeof data.searxngTemplate === 'string' ? data.searxngTemplate : '';

      if (!data.exists && typeof window !== 'undefined') {
        // One-time migration: nothing stored server-side yet — carry
        // forward a legacy localStorage value if one exists, then persist
        // it server-side and stop touching localStorage from now on.
        try {
          const raw = localStorage.getItem(LEGACY_KEY);
          if (raw) {
            const legacy = JSON.parse(raw) as Partial<{
              toolsEnabled: boolean;
              searxngTemplate: string;
            }>;
            if (typeof legacy.toolsEnabled === 'boolean') toolsEnabled = legacy.toolsEnabled;
            if (typeof legacy.searxngTemplate === 'string' && legacy.searxngTemplate) {
              searxngTemplate = legacy.searxngTemplate;
            }
            await putSettings({ toolsEnabled, searxngTemplate });
            localStorage.removeItem(LEGACY_KEY);
          }
        } catch {
          /* ignore */
        }
      }

      set({ toolsEnabled, searxngTemplate });
    } catch {
      /* ignore */
    }
  },
}));
