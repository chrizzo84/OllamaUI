import { NextRequest } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const KEY = 'telegram';

interface TelegramSettings {
  // Whether a fired scheduled task/reminder's result also gets pushed to
  // Telegram (in addition to always landing in a new web UI session — see
  // scheduler.ts's runScheduledTask). Only meaningful when the bridge is
  // actually configured (TELEGRAM_BOT_TOKEN/TELEGRAM_ALLOWED_USER_ID env
  // vars) — this setting doesn't enable/disable the bridge itself, just
  // whether background runs specifically notify through it.
  notifyScheduledTasks: boolean;
}

// Defaults ON — the whole point of setting up the Telegram bridge is to
// still hear about a reminder/task result with no tab open; this only
// exists so it can be turned back off if the push volume gets annoying.
const DEFAULTS: TelegramSettings = { notifyScheduledTasks: true };

export async function GET() {
  const stored = getSetting<TelegramSettings>(KEY);
  return Response.json({ ...DEFAULTS, ...stored, exists: !!stored });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const current = { ...DEFAULTS, ...getSetting<TelegramSettings>(KEY) };
  const next: TelegramSettings = {
    notifyScheduledTasks:
      typeof body.notifyScheduledTasks === 'boolean'
        ? body.notifyScheduledTasks
        : current.notifyScheduledTasks,
  };
  setSetting(KEY, next);
  return Response.json({ ...next, exists: true });
}
