import { create } from 'zustand';
import type { ChatMessage } from '@/store/chat';

export interface SessionMeta {
  id: string;
  title: string;
  titleStatus: 'pending' | 'ready';
  profileId: string | null;
  modelA: string;
  modelB: string;
  compareMode: boolean;
  // Per-session override for the global memory setting — null = inherit the
  // global default (see src/store/memory.ts). See db.ts's SessionRow.
  memoryEnabled: boolean | null;
  // True only for the single, persistent Telegram bridge conversation — see
  // db.ts's SessionRow. Fixed at creation, never patched from the UI.
  isTelegram: boolean;
  updatedAt: number;
}

interface RawSessionMeta {
  id: string;
  title: string;
  titleStatus?: string;
  profileId?: string | null;
  modelA?: string;
  modelB?: string;
  compareMode?: boolean;
  memoryEnabled?: boolean | null;
  isTelegram?: boolean;
  updatedAt?: number;
}

type PatchableFields = Partial<
  Pick<
    SessionMeta,
    'title' | 'titleStatus' | 'profileId' | 'modelA' | 'modelB' | 'compareMode' | 'memoryEnabled'
  >
>;

function normalize(o: RawSessionMeta): SessionMeta {
  return {
    id: o.id,
    title: o.title || 'New chat',
    titleStatus: o.titleStatus === 'pending' ? 'pending' : 'ready',
    profileId: o.profileId ?? null,
    modelA: o.modelA || '',
    modelB: o.modelB || '',
    compareMode: !!o.compareMode,
    memoryEnabled: o.memoryEnabled ?? null,
    isTelegram: !!o.isTelegram,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : Date.now(),
  };
}

interface SessionsState {
  sessions: SessionMeta[];
  activeId: string | null;
  hydrated: boolean;
  hydrate(): Promise<void>;
  create(profileId?: string | null): Promise<string>;
  rename(id: string, title: string): void;
  remove(id: string): void;
  setActive(id: string): void;
  patch(id: string, partial: PatchableFields): void;
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  sessions: [],
  activeId: null,
  hydrated: false,
  hydrate: async () => {
    if (get().hydrated) return;
    // Set synchronously (before the first await) so a second, concurrent
    // hydrate() call (e.g. React Strict Mode's double effect invocation in
    // dev) sees this immediately and bails out, instead of both calls racing
    // past the guard and each auto-creating a session below.
    set({ hydrated: true });
    try {
      const r = await fetch('/api/sessions', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        const items: RawSessionMeta[] = Array.isArray(j.items) ? j.items : [];
        let sessions = items.map(normalize).sort((a, b) => b.updatedAt - a.updatedAt);
        if (sessions.length === 0) {
          const id = await get().create(null);
          sessions = get().sessions;
          set({ activeId: id });
        } else {
          set({ sessions });
          const current = get().activeId;
          if (!current || !sessions.some((s) => s.id === current)) {
            set({ activeId: sessions[0]?.id || null });
          }
        }
      }
    } catch {
      /* ignore */
    }
  },
  create: async (profileId) => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profileId: profileId ?? null }),
    });
    const data = await res.json();
    const meta = normalize(data);
    set((s) => ({ sessions: [meta, ...s.sessions], activeId: meta.id }));
    return meta.id;
  },
  rename: (id, title) => {
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title, titleStatus: 'ready' } : x)),
    }));
    fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, titleStatus: 'ready' }),
    }).catch(() => {
      /* ignore */
    });
  },
  remove: (id) => {
    set((s) => {
      const remaining = s.sessions.filter((x) => x.id !== id);
      return {
        sessions: remaining,
        activeId: s.activeId === id ? remaining[0]?.id || null : s.activeId,
      };
    });
    fetch(`/api/sessions/${id}`, { method: 'DELETE' }).catch(() => {
      /* ignore */
    });
  },
  setActive: (id) => set({ activeId: id }),
  patch: (id, partial) => {
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id ? { ...x, ...partial, updatedAt: Date.now() } : x,
      ),
    }));
    fetch(`/api/sessions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(partial),
    }).catch(() => {
      /* ignore */
    });
  },
}));

// Full message history isn't kept in the lightweight sessions store (so the
// sidebar list stays cheap to hydrate) — loaded/persisted on demand instead.

export async function loadSessionMessages(sessionId: string): Promise<ChatMessage[]> {
  try {
    const r = await fetch(`/api/sessions/${sessionId}`, { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j.messages) ? j.messages : [];
  } catch {
    return [];
  }
}

// The PATCH endpoint overwrites `messages` wholesale (no merge, no version
// check), and callers (send/regenerate/delete/compact) fire this off without
// awaiting it. Without ordering, a slow earlier write can land after a later,
// more complete one and silently clobber it back to a stale snapshot. Chain
// writes per session so they always reach the server in call order.
const persistQueues = new Map<string, Promise<void>>();

export function persistSessionMessages(sessionId: string, messages: ChatMessage[]): void {
  const prior = persistQueues.get(sessionId) ?? Promise.resolve();
  const next = prior
    .catch(() => {
      /* a previous failure shouldn't block this write */
    })
    .then(() =>
      fetch(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      }),
    )
    .then(() => undefined)
    .catch((e) => {
      console.error(`Failed to persist messages for session ${sessionId}:`, e);
    })
    .finally(() => {
      if (persistQueues.get(sessionId) === next) persistQueues.delete(sessionId);
    });
  persistQueues.set(sessionId, next);
}
