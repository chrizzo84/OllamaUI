import { create } from 'zustand';

export interface ToastItem {
  id: string;
  title?: string;
  message: string;
  type?: 'info' | 'success' | 'error';
  createdAt: number;
}

interface ToastState {
  toasts: ToastItem[];
  push(t: Omit<ToastItem, 'id' | 'createdAt'>): void;
  dismiss(id: string): void;
  clear(): void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (t) =>
    set((s) => ({
      toasts: [...s.toasts, { id: crypto.randomUUID(), createdAt: Date.now(), ...t }].slice(-50),
    })),
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  clear: () => set({ toasts: [] }),
}));
