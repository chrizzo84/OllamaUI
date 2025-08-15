import { create } from 'zustand';

export type ThemeName = 'default' | 'dark-green' | 'neon' | 'neon-orange';

interface ThemeState {
  theme: ThemeName;
  setTheme(t: ThemeName): void;
  hydrate(): void;
}

const STORAGE_KEY = 'ollama_ui_theme';

export const useThemeStore = create<ThemeState>((set, get) => ({
  theme: 'default',
  setTheme: (t) => {
    set({ theme: t });
    try {
      if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, t);
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.theme = t;
      }
    } catch {
      /* ignore */
    }
  },
  hydrate: () => {
    if (typeof window === 'undefined') return;
    try {
      const stored = localStorage.getItem(STORAGE_KEY) as ThemeName | null;
      if (stored && stored !== get().theme) {
        get().setTheme(stored);
      } else {
        document.documentElement.dataset.theme = get().theme;
      }
    } catch {
      /* ignore */
    }
  },
}));
