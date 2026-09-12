/**
 * Per-GPU memory for the Running Models page. Ollama's `/api/ps` only ever
 * reports one VRAM total per model, summed over every card it used, so the
 * per-card numbers have to come from the machine itself — see
 * src/lib/gpu-devices.ts for how, and for why this is gated on the active
 * Ollama host being local.
 *
 * Never fails: a machine with no GPU tooling, or a remote Ollama, gets an
 * empty device list plus the reason, which is exactly what the page renders.
 */
import { resolveOllamaHostServer } from '@/lib/host-resolve-server';
import { probeGpuDevices, shouldProbe, type GpuProbeResult } from '@/lib/gpu-devices';

export const runtime = 'nodejs';

// The page polls every 4s and spawning nvidia-smi per request is wasteful
// with two browser tabs open, let alone the popover as well. A 2s window
// keeps the reading live while collapsing the duplicates.
const TTL_MS = 2000;
let cache: { at: number; value: GpuProbeResult } | null = null;

export async function GET() {
  const host = resolveOllamaHostServer();
  const gate = shouldProbe(host);
  if (!gate.probe) {
    return Response.json({ devices: [], source: null, reason: gate.reason, probed: false });
  }
  if (cache && Date.now() - cache.at < TTL_MS) {
    return Response.json({ ...cache.value, probed: true, cached: true });
  }
  try {
    const value = await probeGpuDevices();
    cache = { at: Date.now(), value };
    return Response.json({ ...value, probed: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'GPU probe failed';
    return Response.json({ devices: [], source: null, reason: msg, probed: true });
  }
}
