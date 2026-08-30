// Live health check for the three external services this app depends on
// (Ollama, whisper.cpp for voice, the Telegram bridge) — backs the Settings
// page's status panel. Built directly out of a real debugging session: a
// Telegram bot that silently does nothing (wrong env var, a bot token
// rotated in Telegram but not updated in the deployed container, ...) gave
// no visible signal anywhere before this existed.
import { checkOllama, checkWhisper } from '@/lib/status-checks';
import { getTelegramDiagnostics } from '@/lib/telegram-bridge';

export const runtime = 'nodejs';

export async function GET() {
  const [ollama, whisper, telegram] = await Promise.all([
    checkOllama(),
    checkWhisper(),
    getTelegramDiagnostics(),
  ]);
  return Response.json({ ollama, whisper, telegram, checkedAt: Date.now() });
}
