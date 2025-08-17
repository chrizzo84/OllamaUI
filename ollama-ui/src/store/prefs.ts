import { create } from 'zustand';

interface PrefsState {
  // State
  hydrated: boolean;
  requireDeleteConfirm: boolean;
  autoRefreshModelsSeconds: number;
  searxngUrl: string;
  searchLimit: number;

  // Actions
  setRequireDeleteConfirm(v: boolean): void;
  setAutoRefreshModelsSeconds(v: number): void;
  setSearxngUrl(v: string): void;
  setSearchLimit(v: number): void;
  hydrate(): Promise<void>;
}

async function savePrefs(patch: Partial<PrefsState>) {
  try {
    await fetch('/api/prefs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (e) {
    console.error('Failed to save preferences', e);
  }
}

export const usePrefsStore = create<PrefsState>((set, get) => ({
  hydrated: false,
  requireDeleteConfirm: true,
  autoRefreshModelsSeconds: 0,
  searxngUrl: '',
  searchLimit: 5,

  setRequireDeleteConfirm: (v) => {
    set({ requireDeleteConfirm: v });
    savePrefs({ requireDeleteConfirm: v });
  },
  setAutoRefreshModelsSeconds: (v) => {
    set({ autoRefreshModelsSeconds: v });
    savePrefs({ autoRefreshModelsSeconds: v });
  },
  setSearxngUrl: (v) => {
    set({ searxngUrl: v });
    savePrefs({ searxngUrl: v });
  },
  setSearchLimit: (v) => {
    set({ searchLimit: v });
    savePrefs({ searchLimit: v });
  },
  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const res = await fetch('/api/prefs');
      if (!res.ok) throw new Error('Failed to fetch prefs');
      const prefs = await res.json();
      set({ ...prefs, hydrated: true });
    } catch (e) {
      console.error('Failed to hydrate prefs store', e);
      // still need to mark as hydrated to avoid infinite loops
      set({ hydrated: true });
    }
  },
}));
