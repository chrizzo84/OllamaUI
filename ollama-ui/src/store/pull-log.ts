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
  /*
  A whole chunk of the stream in one update.

  Ollama's pull stream is not a handful of status lines: a multi-gigabyte
  model emits progress many times a second, and one store write per line
  meant one array copy and one re-render of the page per line. Writing them
  as they arrive — in the batches the network already delivers them in — is
  the same data at a fraction of the work.
  */
  addMany(model: string, items: PullData[]): void;
  clear(model?: string): void;
}

const MAX_EVENTS = 2000;

function toEvent(model: string, data: PullData): PullEvent {
  return {
    id: safeUuid(),
    timestamp: Date.now(),
    model,
    data,
    percentage:
      typeof (data as PullStructuredEvent)?.percentage === 'number'
        ? (data as PullStructuredEvent).percentage
        : undefined,
  };
}

export const usePullLogStore = create<PullLogState>((set) => ({
  events: [],
  add: (model, data) =>
    set((s) => ({ events: [...s.events, toEvent(model, data)].slice(-MAX_EVENTS) })),
  addMany: (model, items) =>
    set((s) =>
      items.length
        ? { events: [...s.events, ...items.map((d) => toEvent(model, d))].slice(-MAX_EVENTS) }
        : s,
    ),
  clear: (model) =>
    set((s) => ({
      events: model ? s.events.filter((e) => e.model !== model) : [],
    })),
}));
