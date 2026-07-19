import { create } from 'zustand';

interface PrefsState {
  requireDeleteConfirm: boolean;
  autoRefreshModelsSeconds: number; // 0 = disabled
  numCtxByModel: Record<string, number>; // per-model num_ctx override; absent = server default
  autoCompactEnabled: boolean; // auto-trigger context compaction near the context limit
  autoCompactThresholdPct: number; // 50-95
  setRequireDeleteConfirm(v: boolean): void;
  setAutoRefreshModelsSeconds(v: number): void;
  setNumCtxForModel(model: string, value: number | null): void; // null clears the override
  setAutoCompactEnabled(v: boolean): void;
  setAutoCompactThresholdPct(v: number): void;
  hydrate(): void;
}

const KEY = 'ollama_ui_prefs_v1';

type PersistShape = Pick<
  PrefsState,
  | 'requireDeleteConfirm'
  | 'autoRefreshModelsSeconds'
  | 'numCtxByModel'
  | 'autoCompactEnabled'
  | 'autoCompactThresholdPct'
>;

export const usePrefsStore = create<PrefsState>((set) => ({
  requireDeleteConfirm: true,
  autoRefreshModelsSeconds: 0,
  numCtxByModel: {},
  autoCompactEnabled: false,
  autoCompactThresholdPct: 80,
  setRequireDeleteConfirm: (v) => {
    set({ requireDeleteConfirm: v });
    persist();
  },
  setAutoRefreshModelsSeconds: (v) => {
    set({ autoRefreshModelsSeconds: v });
    persist();
  },
  setNumCtxForModel: (model, value) => {
    set((s) => {
      const next = { ...s.numCtxByModel };
      if (value == null) delete next[model];
      else next[model] = value;
      return { numCtxByModel: next };
    });
    persist();
  },
  setAutoCompactEnabled: (v) => {
    set({ autoCompactEnabled: v });
    persist();
  },
  setAutoCompactThresholdPct: (v) => {
    set({ autoCompactThresholdPct: v });
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
        if (parsed.numCtxByModel && typeof parsed.numCtxByModel === 'object') {
          const clean: Record<string, number> = {};
          for (const [k, v] of Object.entries(parsed.numCtxByModel)) {
            if (typeof v === 'number' && v > 0) clean[k] = v;
          }
          set({ numCtxByModel: clean });
        }
        if (typeof parsed.autoCompactEnabled === 'boolean')
          set({ autoCompactEnabled: parsed.autoCompactEnabled });
        if (
          typeof parsed.autoCompactThresholdPct === 'number' &&
          parsed.autoCompactThresholdPct >= 50 &&
          parsed.autoCompactThresholdPct <= 95
        )
          set({ autoCompactThresholdPct: parsed.autoCompactThresholdPct });
      }
    } catch {
      /* ignore */
    }
  },
}));

function persist() {
  try {
    if (typeof window === 'undefined') return;
    const {
      requireDeleteConfirm,
      autoRefreshModelsSeconds,
      numCtxByModel,
      autoCompactEnabled,
      autoCompactThresholdPct,
    } = usePrefsStore.getState();
    const data: PersistShape = {
      requireDeleteConfirm,
      autoRefreshModelsSeconds,
      numCtxByModel,
      autoCompactEnabled,
      autoCompactThresholdPct,
    };
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}
