'use client';
// Settings page status board for the three external services this app
// depends on (Ollama, whisper.cpp, the Telegram bridge) — backed by
// GET /api/status. Built directly out of a real debugging session where the
// Telegram bot silently did nothing after a redeploy and there was no way
// to tell why without digging through container logs.
import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

interface ServiceStatus {
  configured: boolean;
  host: string | null;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  modelCount?: number;
}

interface TelegramStatus {
  tokenPresent: boolean;
  allowedUserIdPresent: boolean;
  modelPresent: boolean;
  tokenValid: boolean | null;
  botUsername: string | null;
  tokenError: string | null;
  bridge: {
    started: boolean;
    lastSuccessAt: number | null;
    lastErrorAt: number | null;
    lastError: string | null;
    consecutiveFailures: number;
  };
}

interface StatusResponse {
  ollama: ServiceStatus;
  whisper: ServiceStatus;
  telegram: TelegramStatus;
  checkedAt: number;
}

type Level = 'ok' | 'warn' | 'error' | 'off';

const DOT: Record<Level, string> = {
  ok: 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]',
  warn: 'bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]',
  error: 'bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.8)]',
  off: 'bg-white/25',
};

function formatAgo(ts: number | null): string {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
}

function Row({ level, title, detail }: { level: Level; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-2.5 py-1.5">
      <span className={`h-2 w-2 rounded-full mt-1 shrink-0 ${DOT[level]}`} />
      <div className="min-w-0">
        <div className="text-xs text-white/80">{title}</div>
        <div className="text-[10px] text-white/40 font-mono break-words">{detail}</div>
      </div>
    </div>
  );
}

export function StatusPanel() {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/status', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshButton = (
    <button
      type="button"
      onClick={() => void refresh()}
      disabled={loading}
      className="text-[10px] text-white/40 hover:text-white/80 flex items-center gap-1 disabled:opacity-40 shrink-0"
    >
      <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
      Refresh
    </button>
  );

  if (error && !data) {
    return (
      <div className="flex items-center justify-between gap-2 text-xs text-red-300/80">
        <span>Could not load status: {error}</span>
        {refreshButton}
      </div>
    );
  }

  if (!data) {
    return <div className="text-xs text-white/40">Checking…</div>;
  }

  const { ollama, whisper, telegram } = data;

  const ollamaLevel: Level = !ollama.configured ? 'off' : ollama.reachable ? 'ok' : 'error';
  const ollamaDetail = !ollama.configured
    ? 'No active Ollama host — add one below.'
    : ollama.reachable
      ? `${ollama.host} — ${ollama.modelCount ?? '?'} model(s), ${ollama.latencyMs}ms`
      : `${ollama.host} — unreachable (${ollama.error})`;

  const whisperLevel: Level = !whisper.configured ? 'off' : whisper.reachable ? 'ok' : 'error';
  const whisperDetail = !whisper.configured
    ? 'WHISPER_HOST not set — voice messages are disabled.'
    : whisper.reachable
      ? `${whisper.host} — reachable, ${whisper.latencyMs}ms`
      : `${whisper.host} — unreachable (${whisper.error})`;

  let telegramLevel: Level;
  let telegramDetail: string;
  if (!telegram.tokenPresent || !telegram.allowedUserIdPresent) {
    telegramLevel = 'off';
    telegramDetail = 'TELEGRAM_BOT_TOKEN / TELEGRAM_ALLOWED_USER_ID not set — bridge disabled.';
  } else if (telegram.tokenValid === false) {
    telegramLevel = 'error';
    telegramDetail = `Token rejected by Telegram — likely revoked/rotated (${telegram.tokenError}). Update TELEGRAM_BOT_TOKEN and restart the container.`;
  } else if (!telegram.modelPresent) {
    telegramLevel = 'warn';
    telegramDetail = 'Token OK, but TELEGRAM_MODEL is not set.';
  } else if (telegram.bridge.consecutiveFailures >= 3) {
    telegramLevel = 'error';
    telegramDetail = `Polling is failing (${telegram.bridge.consecutiveFailures}x in a row): ${telegram.bridge.lastError}`;
  } else if (telegram.bridge.lastSuccessAt) {
    telegramLevel = 'ok';
    telegramDetail = `Connected as @${telegram.botUsername ?? '?'} — last poll ${formatAgo(telegram.bridge.lastSuccessAt)}.`;
  } else {
    telegramLevel = 'warn';
    telegramDetail = `Token OK as @${telegram.botUsername ?? '?'}, waiting for the first successful poll…`;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-white/30 font-mono">
          checked {formatAgo(data.checkedAt)}
        </span>
        {refreshButton}
      </div>
      <div className="divide-y divide-white/5">
        <Row level={ollamaLevel} title="Ollama" detail={ollamaDetail} />
        <Row level={whisperLevel} title="Whisper (voice)" detail={whisperDetail} />
        <Row level={telegramLevel} title="Telegram bridge" detail={telegramDetail} />
      </div>
    </div>
  );
}
