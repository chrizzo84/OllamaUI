import { create } from 'zustand';
import { safeUuid, isThinkingModel } from '@/lib/utils';
import { ChatMessage } from '@/components/single-chat-view';

type ChatInstance = 'A' | 'B';

interface PlaygroundState {
  messagesA: ChatMessage[];
  modelA: string;
  loadingA: boolean;
  temperatureA: number;
  seedA?: number;

  messagesB: ChatMessage[];
  modelB: string;
  loadingB: boolean;
  temperatureB: number;
  seedB?: number;

  setModel: (instance: ChatInstance, model: string) => void;
  setOptions: (instance: ChatInstance, options: { temperature?: number; seed?: number }) => void;
  appendMessage: (instance: ChatInstance, message: Omit<ChatMessage, 'id' | 'createdAt'>) => string;
  updateMessage: (
    instance: ChatInstance,
    id: string,
    patch: Partial<Pick<ChatMessage, 'content' | 'raw' | 'thinking'>>,
  ) => void;
  setLoading: (instance: ChatInstance, loading: boolean) => void;
  clear: (instance: ChatInstance) => void;

  send: (instance: ChatInstance, prompt: string) => Promise<void>;
}

export const usePlaygroundStore = create<PlaygroundState>((set, get) => ({
  messagesA: [],
  modelA: '',
  loadingA: false,
  temperatureA: 0.8,
  seedA: undefined,

  messagesB: [],
  modelB: '',
  loadingB: false,
  temperatureB: 0.8,
  seedB: undefined,

  setModel: (instance, model) => {
    if (instance === 'A') {
      set({ modelA: model });
    } else {
      set({ modelB: model });
    }
  },

  setOptions: (instance, options) => {
    if (instance === 'A') {
      set({
        ...(options.temperature !== undefined && { temperatureA: options.temperature }),
        ...(options.seed !== undefined && { seedA: options.seed }),
      });
    } else {
      set({
        ...(options.temperature !== undefined && { temperatureB: options.temperature }),
        ...(options.seed !== undefined && { seedB: options.seed }),
      });
    }
  },

  appendMessage: (instance, message) => {
    const id = safeUuid();
    const fullMessage = { id, createdAt: Date.now(), ...message };
    if (instance === 'A') {
      set((state) => ({ messagesA: [...state.messagesA, fullMessage] }));
    } else {
      set((state) => ({ messagesB: [...state.messagesB, fullMessage] }));
    }
    return id;
  },

  updateMessage: (instance, id, patch) => {
    if (instance === 'A') {
      set((state) => ({
        messagesA: state.messagesA.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }));
    } else {
      set((state) => ({
        messagesB: state.messagesB.map((m) => (m.id === id ? { ...m, ...patch } : m)),
      }));
    }
  },

  setLoading: (instance, loading) => {
    if (instance === 'A') {
      set({ loadingA: loading });
    } else {
      set({ loadingB: loading });
    }
  },

  clear: (instance) => {
    if (instance === 'A') {
      set({ messagesA: [] });
    } else {
      set({ messagesB: [] });
    }
  },

  send: async (instance, prompt) => {
    const {
      modelA,
      modelB,
      temperatureA,
      seedA,
      temperatureB,
      seedB,
      appendMessage,
      updateMessage,
      setLoading,
    } = get();
    const model = instance === 'A' ? modelA : modelB;
    const temperature = instance === 'A' ? temperatureA : temperatureB;
    const seed = instance === 'A' ? seedA : seedB;

    if (!prompt.trim() || !model) return;

    setLoading(instance, true);

    appendMessage(instance, { role: 'user', content: prompt, model });
    const assistantId = appendMessage(instance, { role: 'assistant', content: '…', model });

    try {
      const messages = instance === 'A' ? get().messagesA : get().messagesB;
      const upstreamMessages = messages
        .filter((m) => m.role !== 'assistant' || m.content)
        .map((m) => ({ role: m.role, content: m.content }));

      const payload = {
        model,
        messages: upstreamMessages,
        think: isThinkingModel(model),
        options: {
          temperature,
          seed,
        },
      };

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.body) throw new Error('No body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let thinkingRaw = '';
      let responseRaw = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const obj = JSON.parse(line) as Record<string, unknown>;
            if (typeof obj.thinking === 'string') {
              thinkingRaw += obj.thinking;
            } else if (typeof obj.token === 'string') {
              responseRaw += obj.token;
            } else if (obj.done === true) {
              if (typeof obj.content === 'string') responseRaw = obj.content;
              if (typeof obj.thinking === 'string') thinkingRaw = obj.thinking;
            } else if (obj.error) {
              updateMessage(instance, assistantId, {
                content: '[Error] ' + String(obj.error),
                thinking: thinkingRaw || undefined,
              });
              continue;
            }
            updateMessage(instance, assistantId, {
              content: responseRaw,
              thinking: thinkingRaw || undefined,
            });
          } catch {
            // ignore parse errors
          }
        }
      }
    } catch (e) {
      updateMessage(instance, assistantId, {
        content: `[Chat Error] ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setLoading(instance, false);
    }
  },
}));
