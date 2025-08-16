import { create } from 'zustand';

interface PrefsState {
  requireDeleteConfirm: boolean;
  autoRefreshModelsSeconds: number; // 0 = disabled
  searxngUrl: string;
  setRequireDeleteConfirm(v: boolean): void;
  setAutoRefreshModelsSeconds(v: number): void;
  setSearxngUrl(v: string): void;
  hydrate(): void;
}

const KEY = 'ollama_ui_prefs_v1';

type PersistShape = Pick<
  PrefsState,
  'requireDeleteConfirm' | 'autoRefreshModelsSeconds' | 'searxngUrl'
>;

export const usePrefsStore = create<PrefsState>((set) => ({
  requireDeleteConfirm: true,
  autoRefreshModelsSeconds: 0,
  searxngUrl: '',
  setRequireDeleteConfirm: (v) => {
    set({ requireDeleteConfirm: v });
    persist();
  },
  setAutoRefreshModelsSeconds: (v) => {
    set({ autoRefreshModelsSeconds: v });
    persist();
  },
  setSearxngUrl: (v) => {
    set({ searxngUrl: v });
    persist();
  },
  hydrate: () => {
    if (typeof window === 'undefined') return;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const parsed: Partial<PersistShape> = JSON.parse(raw);
        if (typeof parsed.requireDeleteConfirm === 'boolean')
          set({ requireDeleteConfirm: parsed.requireDeleteConfirm });
        if (typeof parsed.autoRefreshModelsSeconds === 'number')
          set({ autoRefreshModelsSeconds: parsed.autoRefreshModelsSeconds });
        if (typeof parsed.searxngUrl === 'string') set({ searxngUrl: parsed.searxngUrl });
      }
    } catch {
      /* ignore */
    }
  },
}));

function persist() {
  try {
    if (typeof window === 'undefined') return;
    const { requireDeleteConfirm, autoRefreshModelsSeconds, searxngUrl } =
      usePrefsStore.getState();
    const data: PersistShape = { requireDeleteConfirm, autoRefreshModelsSeconds, searxngUrl };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}
