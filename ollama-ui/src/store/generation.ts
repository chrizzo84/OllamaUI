import { create } from 'zustand';

// Per (session, column) in-flight generation state, keyed by
// `${sessionId}:${column}`. Lives outside useColumnChat's component state so
// that switching the active session doesn't lose track of — or worse,
// clobber — a generation still running for a session the user just navigated
// away from. Each session+column can have at most one in-flight generation
// (that's an actual conversation-turn constraint), but different sessions
// (or the same session's two compare columns) are fully independent and may
// run concurrently.
export interface GenerationEntry {
  loading: boolean;
  streamingId: string | null;
  coldStart: boolean;
  coldStartSince: number | null;
  jobId: string | null;
  abortController: AbortController | null;
  // How many other jobs were already running against the same model when
  // this one started (see the `queued` wire event in chat-stream.ts) — a
  // heads-up only, not a guarantee this job will or won't run alongside
  // them. Cleared as soon as this job's own output starts arriving.
  queuedAhead: number | null;
}

const EMPTY_ENTRY: GenerationEntry = {
  loading: false,
  streamingId: null,
  coldStart: false,
  coldStartSince: null,
  jobId: null,
  abortController: null,
  queuedAhead: null,
};

export function generationKey(sessionId: string, column: 'A' | 'B'): string {
  return `${sessionId}:${column}`;
}

interface GenerationState {
  entries: Record<string, GenerationEntry>;
  patch(key: string, patch: Partial<GenerationEntry>): void;
}

export const useGenerationStore = create<GenerationState>((set) => ({
  entries: {},
  patch: (key, patch) =>
    set((s) => ({
      entries: { ...s.entries, [key]: { ...(s.entries[key] ?? EMPTY_ENTRY), ...patch } },
    })),
}));

export function getGenerationEntry(key: string): GenerationEntry {
  return useGenerationStore.getState().entries[key] ?? EMPTY_ENTRY;
}
