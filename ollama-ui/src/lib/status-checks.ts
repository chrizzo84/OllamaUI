// Live reachability checks for Ollama and whisper.cpp, backing the
// Settings page's status panel (GET /api/status, src/app/api/status/
// route.ts) alongside telegram-bridge.ts's own getTelegramDiagnostics. Kept
// separate from that file since neither of these has anything to do with
// Telegram specifically.
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { getWhisperHost } from '@/lib/whisper';

const CHECK_TIMEOUT_MS = 5000;

export interface ServiceStatus {
  configured: boolean;
  host: string | null;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  // Ollama only — omitted for whisper.
  modelCount?: number;
}

// Same source as every other server-side Ollama call in this app
// (telegram-bridge.ts, scheduler.ts) — the active DB host, no per-request
// cookie/header available outside a real HTTP request.
export async function checkOllama(): Promise<ServiceStatus> {
  const base = resolveOllamaHostServer();
  if (!base)
    return { configured: false, host: null, reachable: false, latencyMs: null, error: null };
  const start = Date.now();
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    const latencyMs = Date.now() - start;
    if (!res.ok) {
      return {
        configured: true,
        host: base,
        reachable: false,
        latencyMs,
        error: `HTTP ${res.status}`,
      };
    }
    const data = await res.json();
    const modelCount = Array.isArray(data?.models) ? data.models.length : undefined;
    return { configured: true, host: base, reachable: true, latencyMs, error: null, modelCount };
  } catch (e) {
    return {
      configured: true,
      host: base,
      reachable: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// whisper-server (whisper.cpp) serves its own small web UI at "/" — any
// HTTP response at all (even a 404) already proves the port is alive and
// answering, so only a network-level failure (connection refused, DNS,
// timeout) counts as unreachable here.
export async function checkWhisper(): Promise<ServiceStatus> {
  const host = getWhisperHost();
  if (!host)
    return { configured: false, host: null, reachable: false, latencyMs: null, error: null };
  const start = Date.now();
  try {
    await fetch(host, { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    return { configured: true, host, reachable: true, latencyMs: Date.now() - start, error: null };
  } catch (e) {
    return {
      configured: true,
      host,
      reachable: false,
      latencyMs: Date.now() - start,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
