import { create } from 'zustand';

// Global (not per-chat) memory setting — whether the assistant may recall
// stored facts and save new ones via the `remember_fact` tool. Defaults to
// ON server-side (see api/settings/memory/route.ts). A specific chat can
// still override this individually — see SessionMeta.memoryEnabled in
// store/sessions.ts and the memory pill in chat-panel.tsx. Persisted
// server-side (data/app.db, `settings` table), same pattern as store/tools.ts.
interface MemoryState {
  memoryEnabled: boolean;
  hydrated: boolean;
  setMemoryEnabled(v: boolean): void;
  hydrate(): Promise<void>;
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  memoryEnabled: true,
  hydrated: false,
  setMemoryEnabled: (v) => {
    set({ memoryEnabled: v });
    fetch('/api/settings/memory', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memoryEnabled: v }),
    }).catch(() => {
      /* ignore */
    });
  },
  hydrate: async () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    try {
      const r = await fetch('/api/settings/memory', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      set({ memoryEnabled: typeof data.memoryEnabled === 'boolean' ? data.memoryEnabled : true });
    } catch {
      /* ignore */
    }
  },
}));
