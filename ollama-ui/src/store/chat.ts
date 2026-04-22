import { create } from 'zustand';
import { safeUuid } from '@/lib/utils';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string; // separated reasoning/thinking content
  raw?: string;
  createdAt: number;
  model?: string;
  profileId?: string;
}

interface ChatState {
  messages: ChatMessage[];
  append(msg: Omit<ChatMessage, 'id' | 'createdAt'>): string; // returns new id
  update(
    id: string,
    patch: Partial<Pick<ChatMessage, 'content' | 'role' | 'raw' | 'thinking'>>,
  ): void;
  clear(profileId?: string): void;
  restore(messages: ChatMessage[], profileId?: string): void; // replace full history (used for undo)
  tagUntagged(profileId: string): void; // migrate legacy messages without profile
}

export const useChatStore = create<ChatState>((set) => ({
  messages: [],
  append: (msg) => {
    const id = safeUuid();
    set((s) => ({
      messages: [...s.messages, { id, createdAt: Date.now(), ...msg }].slice(-500),
    }));
    return id;
  },
  update: (id, patch) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    })),
  clear: (profileId) =>
    set((s) => ({
      messages: profileId ? s.messages.filter((m) => m.profileId !== profileId) : [],
    })),
  restore: (messages: ChatMessage[], profileId) =>
    set((s) => ({
      messages: profileId
        ? [...s.messages.filter((m) => m.profileId !== profileId), ...messages].slice(-500)
        : messages.slice(-500),
    })),
  tagUntagged: (profileId: string) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.profileId ? m : { ...m, profileId })),
    })),
}));
