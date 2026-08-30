import { create } from 'zustand';

// Global setting: whether a fired scheduled task/reminder also pushes its
// result to Telegram (see api/settings/telegram/route.ts and
// scheduler.ts's runScheduledTask) — separate from whether the Telegram
// bridge itself is configured (that's env vars, TELEGRAM_BOT_TOKEN etc.,
// not something toggleable from the UI). Defaults ON. Persisted server-side
// (data/app.db, `settings` table), same pattern as store/memory.ts.
interface TelegramSettingsState {
  notifyScheduledTasks: boolean;
  hydrated: boolean;
  setNotifyScheduledTasks(v: boolean): void;
  hydrate(): Promise<void>;
}

export const useTelegramSettingsStore = create<TelegramSettingsState>((set, get) => ({
  notifyScheduledTasks: true,
  hydrated: false,
  setNotifyScheduledTasks: (v) => {
    set({ notifyScheduledTasks: v });
    fetch('/api/settings/telegram', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notifyScheduledTasks: v }),
    }).catch(() => {
      /* ignore */
    });
  },
  hydrate: async () => {
    if (get().hydrated) return;
    set({ hydrated: true });
    try {
      const r = await fetch('/api/settings/telegram', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      set({
        notifyScheduledTasks:
          typeof data.notifyScheduledTasks === 'boolean' ? data.notifyScheduledTasks : true,
      });
    } catch {
      /* ignore */
    }
  },
}));
