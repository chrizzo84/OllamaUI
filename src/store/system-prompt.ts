import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface LamaProfile {
  id: string;
  name: string;
  prompt: string;
  updatedAt: number;
  tags?: string[]; // einfache Tag Liste
}

interface LamaState {
  currentId: string | null;
  profiles: LamaProfile[];
  setCurrent: (id: string | null) => void;
  create: (data: { name: string; prompt?: string }) => string; // returns id
  updatePrompt: (id: string, patch: Partial<Pick<LamaProfile, 'name' | 'prompt'>>) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => string | null;
  resetPrompt: (id: string) => void;
  setTags: (id: string, tags: string[]) => void;
  importProfiles: (incoming: Array<Partial<LamaProfile>>) => { added: number; skipped: number };
  exportProfiles: () => LamaProfile[];
}

export const useSystemPromptStore = create<LamaState>()(
  persist(
    (set, get) => ({
      currentId: null,
      profiles: [],
      setCurrent: (id) => set({ currentId: id }),
      create: ({ name, prompt }) => {
        const id = crypto.randomUUID();
        const p: LamaProfile = {
          id,
          name: name || 'Unbenannt',
          prompt: prompt || '',
          updatedAt: Date.now(),
          tags: [],
        };
        set((s) => ({ profiles: [...s.profiles, p], currentId: id }));
        return id;
      },
      updatePrompt: (id, patch) =>
        set((s) => ({
          profiles: s.profiles.map((p) =>
            p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p,
          ),
        })),
      remove: (id) =>
        set((s) => {
          const remaining = s.profiles.filter((p) => p.id !== id);
          return {
            profiles: remaining,
            currentId: s.currentId === id ? remaining[0]?.id || null : s.currentId,
          };
        }),
      duplicate: (id) => {
        const src = get().profiles.find((p) => p.id === id);
        if (!src) return null;
        const newId = crypto.randomUUID();
        const copy: LamaProfile = {
          id: newId,
          name: src.name + ' Kopie',
          prompt: src.prompt,
          updatedAt: Date.now(),
          tags: [...(src.tags || [])],
        };
        set((s) => ({ profiles: [...s.profiles, copy] }));
        return newId;
      },
      resetPrompt: (id) =>
        set((s) => ({
          profiles: s.profiles.map((p) =>
            p.id === id ? { ...p, prompt: '', updatedAt: Date.now() } : p,
          ),
        })),
      setTags: (id, tags) =>
        set((s) => ({
          profiles: s.profiles.map((p) =>
            p.id === id ? { ...p, tags, updatedAt: Date.now() } : p,
          ),
        })),
      importProfiles: (incoming: Array<Partial<LamaProfile>>) => {
        let added = 0;
        let skipped = 0;
        set((s) => {
          const existingIds = new Set(s.profiles.map((p) => p.id));
          const list: LamaProfile[] = [...s.profiles];
          for (const raw of incoming) {
            try {
              const obj = raw as Partial<LamaProfile> & { tags?: unknown };
              const name = typeof obj.name === 'string' && obj.name.trim() ? obj.name : 'Import';
              const prompt = typeof obj.prompt === 'string' ? obj.prompt : '';
              const tags: string[] = Array.isArray(obj.tags)
                ? obj.tags.filter((t: unknown): t is string => typeof t === 'string').slice(0, 20)
                : [];
              let id = obj.id && typeof obj.id === 'string' ? obj.id : crypto.randomUUID();
              if (existingIds.has(id)) id = crypto.randomUUID();
              const profile: LamaProfile = { id, name, prompt, tags, updatedAt: Date.now() };
              list.push(profile);
              existingIds.add(id);
              added++;
            } catch {
              skipped++;
            }
          }
          return { profiles: list };
        });
        return { added, skipped };
      },
      exportProfiles: () => get().profiles,
    }),
    { name: 'lama-profiles' },
  ),
);
