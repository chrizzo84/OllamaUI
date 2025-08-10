import { create } from 'zustand';
import { safeUuid } from '@/lib/utils';

export interface LamaProfile {
  id: string;
  name: string;
  prompt: string;
  updatedAt: number;
  tags?: string[]; // simple tag list
}

interface LamaState {
  currentId: string | null;
  profiles: LamaProfile[];
  setCurrent: (id: string | null) => void;
  create: (data: { name: string; prompt?: string }) => string; // returns id
  updatePrompt: (id: string, patch: Partial<Pick<LamaProfile, 'name' | 'prompt' | 'tags'>>) => void;
  remove: (id: string) => void;
  duplicate: (id: string) => string | null;
  resetPrompt: (id: string) => void;
  setTags: (id: string, tags: string[]) => void;
  importProfiles: (incoming: Array<Partial<LamaProfile>>) => { added: number; skipped: number };
  exportProfiles: () => LamaProfile[];
  setProfiles: (list: LamaProfile[]) => void;
  hydrate: () => Promise<void>;
  hydrated: boolean;
  systemEnabled: boolean;
  setSystemEnabled: (v: boolean) => void;
  toggleSystemEnabled: () => void;
}

export const useSystemPromptStore = create<LamaState>()((set, get) => ({
  currentId: null,
  profiles: [],
  hydrated: false,
  systemEnabled: true,
  setSystemEnabled: (v) => {
    set({ systemEnabled: v });
    if (typeof window !== 'undefined')
      try {
        localStorage.setItem('systemEnabled', JSON.stringify(v));
      } catch {
        /*ignore*/
      }
  },
  toggleSystemEnabled: () => get().setSystemEnabled(!get().systemEnabled),
  setCurrent: (id) => set({ currentId: id }),
  setProfiles: (list) =>
    set((s) => ({
      profiles: list.sort((a, b) => b.updatedAt - a.updatedAt),
      currentId:
        s.currentId && list.some((p) => p.id === s.currentId) ? s.currentId : list[0]?.id || null,
    })),
  hydrate: async () => {
    if (get().hydrated) return; // already done
    try {
      const r = await fetch('/api/lamas', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      const itemsRaw = Array.isArray(j.items) ? j.items : [];
      interface RemoteLamaLike {
        id?: unknown;
        name?: unknown;
        prompt?: unknown;
        tags?: unknown;
        updatedAt?: unknown;
      }
      const normalized: LamaProfile[] = itemsRaw
        .filter((o: unknown): o is RemoteLamaLike => !!o && typeof o === 'object')
        .map((o: RemoteLamaLike) => {
          const tagsSrc: unknown[] = Array.isArray(o.tags) ? o.tags : [];
          const tags = tagsSrc
            .filter((t: unknown): t is string => typeof t === 'string')
            .slice(0, 20);
          return {
            id: typeof o.id === 'string' ? o.id : safeUuid(),
            name: typeof o.name === 'string' && o.name.trim() ? o.name : 'Untitled',
            prompt: typeof o.prompt === 'string' ? o.prompt : '',
            tags,
            updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
          };
        });
      get().setProfiles(normalized);
    } catch {
      /* ignore */
    }
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem('systemEnabled');
        if (raw !== null) {
          const val = JSON.parse(raw);
          if (typeof val === 'boolean') set({ systemEnabled: val });
        }
      } catch {
        /* ignore */
      }
    }
    set({ hydrated: true });
  },
  create: ({ name, prompt }) => {
    // optimistic create via API
    const tempId = safeUuid();
    const profile: LamaProfile = {
      id: tempId,
      name: name || 'Untitled',
      prompt: prompt || '',
      updatedAt: Date.now(),
      tags: [],
    };
    set((s) => ({ profiles: [...s.profiles, profile], currentId: tempId }));
    fetch('/api/lamas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: profile.name, prompt: profile.prompt, tags: profile.tags }),
    })
      .then((r) => r.json())
      .then((data) => {
        set((s) => ({
          profiles: s.profiles.map((p) => (p.id === tempId ? { ...p, ...data } : p)),
          currentId: data.id,
        }));
      })
      .catch(() => {
        // rollback on error
        set((s) => ({ profiles: s.profiles.filter((p) => p.id !== tempId) }));
      });
    return tempId;
  },
  updatePrompt: (id, patch) => {
    set((s) => ({
      profiles: s.profiles.map((p) =>
        p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p,
      ),
    }));
    // debounce network update per id
    scheduleUpdate(id, patch);
  },
  remove: (id) => {
    set((s) => {
      const remaining = s.profiles.filter((p) => p.id !== id);
      return {
        profiles: remaining,
        currentId: s.currentId === id ? remaining[0]?.id || null : s.currentId,
      };
    });
    fetch('/api/lamas?id=' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {
      /* ignore */
    });
  },
  duplicate: (id) => {
    const src = get().profiles.find((p) => p.id === id);
    if (!src) return null;
    return get().create({ name: src.name + ' Copy', prompt: src.prompt });
  },
  resetPrompt: (id) => get().updatePrompt(id, { prompt: '' }),
  setTags: (id, tags) => get().updatePrompt(id, { tags }),
  importProfiles: (incoming: Array<Partial<LamaProfile>>) => {
    const added: string[] = [];
    for (const raw of incoming) {
      if (!raw || typeof raw !== 'object') continue;
      const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Import';
      const prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
      get().create({ name, prompt });
      added.push(name);
    }
    return { added: added.length, skipped: 0 };
  },
  exportProfiles: () => get().profiles,
}));

// --- Debounce Implementation ---
interface PendingPatch {
  name?: string;
  prompt?: string;
  tags?: string[];
}
const pendingPatches: Record<string, PendingPatch> = {};
const pendingTimers: Record<string, ReturnType<typeof setTimeout>> = {};
const DEBOUNCE_MS = 600;

function scheduleUpdate(id: string, patch: PendingPatch) {
  // merge
  pendingPatches[id] = { ...pendingPatches[id], ...patch };
  if (pendingTimers[id]) clearTimeout(pendingTimers[id]);
  pendingTimers[id] = setTimeout(() => flushUpdate(id), DEBOUNCE_MS);
}

function flushUpdate(id: string) {
  const patch = pendingPatches[id];
  if (!patch) return;
  delete pendingPatches[id];
  clearTimeout(pendingTimers[id]);
  delete pendingTimers[id];
  fetch('/api/lamas', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ...patch }),
  }).catch(() => {
    /* swallow */
  });
}
