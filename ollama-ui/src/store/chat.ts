import { create } from 'zustand';
import { safeUuid } from '@/lib/utils';
import type { ChatStats } from '@/lib/chat-stream';

export type { ChatStats };

// A single reasoning burst or tool call, in the order it actually happened.
// Kept as one ordered array (instead of a flat `thinking` string + separate
// `toolCalls` array) so a real think -> call tool -> think more -> answer
// sequence renders in the order the model produced it, not flattened into
// "all thinking, then all tool calls".
export type TraceEvent =
  | { type: 'thinking'; id: string; text: string }
  | {
      type: 'tool';
      id: string;
      name: string;
      arguments: unknown;
      result?: unknown;
      error?: string;
    };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string; // final answer text only
  trace?: TraceEvent[];
  stats?: ChatStats; // token/speed stats for a completed assistant reply
  column?: 'A' | 'B'; // undefined = single-chat message
  raw?: string;
  createdAt: number;
  model?: string;
  sessionId?: string;
}

interface ChatState {
  messages: ChatMessage[];
  append(msg: Omit<ChatMessage, 'id' | 'createdAt'>): string; // returns new id
  update(
    id: string,
    patch: Partial<Pick<ChatMessage, 'content' | 'role' | 'raw' | 'trace' | 'stats'>>,
  ): void;
  clear(sessionId?: string): void;
  restore(messages: ChatMessage[], sessionId?: string): void; // replace full history (used for undo)
  setSessionMessages(sessionId: string, messages: ChatMessage[]): void; // load from persistence
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
  clear: (sessionId) =>
    set((s) => ({
      messages: sessionId ? s.messages.filter((m) => m.sessionId !== sessionId) : [],
    })),
  restore: (messages: ChatMessage[], sessionId) =>
    set((s) => ({
      messages: sessionId
        ? [...s.messages.filter((m) => m.sessionId !== sessionId), ...messages].slice(-500)
        : messages.slice(-500),
    })),
  setSessionMessages: (sessionId, messages) =>
    set((s) => ({
      messages: [...s.messages.filter((m) => m.sessionId !== sessionId), ...messages].slice(-500),
    })),
}));
