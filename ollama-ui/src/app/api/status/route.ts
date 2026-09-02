// Live health check for the three external services this app depends on
// (Ollama, whisper.cpp for voice, the Telegram bridge) — backs the Settings
// page's status panel. Built directly out of a real debugging session: a
// Telegram bot that silently does nothing (wrong env var, a bot token
// rotated in Telegram but not updated in the deployed container, ...) gave
// no visible signal anywhere before this existed.
import { checkOllama, checkWhisper, checkBackups } from '@/lib/status-checks';
import { getTelegramDiagnostics } from '@/lib/telegram-bridge';
import { isAuthEnabled } from '@/lib/auth';

export const runtime = 'nodejs';

export async function GET() {
  const [ollama, whisper, telegram] = await Promise.all([
    checkOllama(),
    checkWhisper(),
    getTelegramDiagnostics(),
  ]);
  // Whether the password gate is on — the Settings page uses this to decide
  // whether to show a sign-out button and to warn when the instance is
  // reachable by anyone. Never exposes the password itself.
  return Response.json({
    ollama,
    whisper,
    telegram,
    auth: { enabled: isAuthEnabled() },
    backups: checkBackups(),
    checkedAt: Date.now(),
  });
}
