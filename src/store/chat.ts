import { create } from 'zustand';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  // content is the displayed (sanitized) content (think-Blöcke entfernt)
  content: string;
  // raw kann vollständigen Stream enthalten (inkl. <think>…</think>)
  raw?: string;
  createdAt: number;
  model?: string;
}

interface ChatState {
  messages: ChatMessage[];
  append(msg: Omit<ChatMessage, 'id' | 'createdAt'>): string; // returns new id
  update(id: string, patch: Partial<Pick<ChatMessage, 'content' | 'role' | 'raw'>>): void;
  clear(): void;
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  append: (msg) => {
    const id = crypto.randomUUID();
    set((s) => ({
      messages: [...s.messages, { id, createdAt: Date.now(), ...msg }].slice(-500),
    }));
    return id;
  },
  update: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  clear: () => set({ messages: [] }),
}));
