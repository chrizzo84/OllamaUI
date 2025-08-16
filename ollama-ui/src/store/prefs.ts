import { create } from 'zustand';

interface PrefsState {
  requireDeleteConfirm: boolean;
  autoRefreshModelsSeconds: number; // 0 = disabled
  searxngUrl: string;
  searchLimit: number;
  setRequireDeleteConfirm(v: boolean): void;
  setAutoRefreshModelsSeconds(v: number): void;
  setSearxngUrl(v: string): void;
  setSearchLimit(v: number): void;
  hydrate(): void;
}

const KEY = 'ollama_ui_prefs_v1';

type PersistShape = Pick<
  PrefsState,
  'requireDeleteConfirm' | 'autoRefreshModelsSeconds' | 'searxngUrl' | 'searchLimit'
>;

export const usePrefsStore = create<PrefsState>((set) => ({
  requireDeleteConfirm: true,
  autoRefreshModelsSeconds: 0,
  searxngUrl: '',
  searchLimit: 5,
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
  setSearchLimit: (v) => {
    set({ searchLimit: v });
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
        if (typeof parsed.searchLimit === 'number') set({ searchLimit: parsed.searchLimit });
      }
    } catch {
      /* ignore */
    }
  },
}));

function persist() {
  try {
    if (typeof window === 'undefined') return;
    const { requireDeleteConfirm, autoRefreshModelsSeconds, searxngUrl, searchLimit } =
      usePrefsStore.getState();
    const data: PersistShape = {
      requireDeleteConfirm,
      autoRefreshModelsSeconds,
      searxngUrl,
      searchLimit,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}
