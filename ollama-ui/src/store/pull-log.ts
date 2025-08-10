import { create } from 'zustand';
import { safeUuid } from '@/lib/utils';

export type PullRawEvent = { raw: string };
export interface PullStructuredEvent {
  status?: string;
  digest?: string;
  total?: number;
  completed?: number;
  percentage?: number;
  done?: boolean;
  [key: string]: unknown;
}

export type PullData = PullRawEvent | PullStructuredEvent;

export interface PullEvent {
  id: string;
  timestamp: number;
  model: string;
  data: PullData; // parsed json or raw
  percentage?: number;
}

interface PullLogState {
  events: PullEvent[];
  add(model: string, data: PullData): void;
  clear(model?: string): void;
}

export const usePullLogStore = create<PullLogState>((set) => ({
  events: [],
  add: (model, data) =>
    set((s) => ({
      events: [
        ...s.events,
        {
          id: safeUuid(),
          timestamp: Date.now(),
          model,
          data,
          percentage:
            typeof (data as PullStructuredEvent)?.percentage === 'number'
              ? (data as PullStructuredEvent).percentage
              : undefined,
        },
      ].slice(-2000), // cap history
    })),
  clear: (model) =>
    set((s) => ({
      events: model ? s.events.filter((e) => e.model !== model) : [],
    })),
}));
