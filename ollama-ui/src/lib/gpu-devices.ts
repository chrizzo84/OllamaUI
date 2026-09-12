/**
 * Per-GPU memory, for the Running Models page.
 *
 * Ollama reports one aggregated `size_vram` per model and nothing else: the
 * per-device breakdown exists inside the server (`vramByDevice` in
 * llm/llama_server.go) but no HTTP route returns it, and `ollama ps` doesn't
 * print it either. On a box with several cards that means the API can say
 * "38 GB in VRAM" and never how that lands across them — one card at 95%
 * and another nearly idle looks identical to an even spread, and "the model
 * doesn't fit" is impossible to tell from "the model doesn't fit *on that
 * card*".
 *
 * The only source for that is the machine itself, so this asks the vendor
 * tool the same way document-extract.ts asks `pdftotext` and whisper.ts asks
 * `ffmpeg`: spawn it with fixed arguments, parse stdout, and treat "not
 * installed" as a plain no-answer rather than an error. Nothing here is
 * required for the page to work — with no usable tool the per-card section
 * is simply absent.
 *
 * IMPORTANT: this reads the GPUs of the machine the *UI* runs on, which is
 * only the same machine Ollama runs on in some setups (the combined Docker
 * image, where Ollama is started inside the same container and the host is
 * `http://localhost:11434`). Pointed at an Ollama on another box, these
 * numbers would describe the wrong hardware — a MacBook's Metal GPU
 * captioned as the usage of a remote two-card Linux server. `shouldProbe`
 * below is what keeps that from happening, and the default is to probe only
 * for a loopback host.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

export interface GpuDevice {
  /** Device index as the vendor tool reports it (`nvidia-smi` GPU 0, 1, …). */
  index: number;
  name: string;
  /** Bytes. Undefined when the tool reported the field as unavailable. */
  memoryTotal?: number;
  memoryUsed?: number;
  /** Busy percentage, 0–100. */
  utilization?: number;
  /**
   * True for GPUs that share one pool with the CPU (Apple Silicon), where
   * "VRAM total" is the machine's whole RAM and a used figure per GPU
   * doesn't exist.
   */
  unified?: boolean;
}

export type GpuSource = 'nvidia-smi' | 'rocm-smi' | 'apple-metal';

export interface GpuProbeResult {
  devices: GpuDevice[];
  source: GpuSource | null;
  /** Why there are no devices — shown in the UI, so keep it a full sentence. */
  reason?: string;
}

const MIB = 1024 * 1024;

/**
 * Runs a vendor CLI and returns its stdout, or null for every way it can
 * fail to produce one (not installed, no driver, non-zero exit, hung). A
 * null is ordinary here: most machines have exactly one of these tools and
 * many have none.
 */
function run(cmd: string, args: string[], timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(null); // spawn itself refused (e.g. EACCES)
      return;
    }
    let stdout = '';
    let settled = false;
    const done = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      // A wedged nvidia-smi (seen when the driver is mid-reset) must not hold
      // the request open — the page polls this every few seconds.
      proc.kill('SIGKILL');
      done(null);
    }, timeoutMs);
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', () => {}); // drained so the pipe can't fill and block
    proc.on('error', () => done(null)); // ENOENT: tool not installed
    proc.on('close', (code) => done(code === 0 ? stdout : null));
  });
}

/**
 * `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` gives one line
 * per card: `0, NVIDIA GeForce RTX 3090, 24576, 11890, 37`. Memory is MiB
 * (that's what `nounits` strips), and any field the driver can't answer
 * comes back as `[N/A]` — those stay undefined instead of becoming 0, which
 * would render as a card with no memory at all.
 *
 * Product names can themselves contain commas, so the name is everything
 * between the leading index and the three trailing numbers rather than
 * "field 2".
 */
export function parseNvidiaSmi(stdout: string): GpuDevice[] {
  const devices: GpuDevice[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = trimmed.split(',').map((f) => f.trim());
    if (fields.length < 5) continue;
    const index = Number(fields[0]);
    if (!Number.isInteger(index)) continue;
    const [totalRaw, usedRaw, utilRaw] = fields.slice(-3);
    const name = fields.slice(1, -3).join(', ').trim();
    devices.push({
      index,
      name: name || `GPU ${index}`,
      memoryTotal: mib(totalRaw),
      memoryUsed: mib(usedRaw),
      utilization: percent(utilRaw),
    });
  }
  return devices.sort((a, b) => a.index - b.index);
}

function mib(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * MIB : undefined;
}

function percent(raw: string): number | undefined {
  const n = Number(raw.replace('%', '').trim());
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined;
}

/**
 * `rocm-smi --json` returns an object keyed by card (`card0`, or `card:0` on
 * some builds), and the field names inside have been renamed repeatedly
 * across ROCm releases ("VRAM Total Memory (B)" vs "vram_total" …). Matching
 * keys by substring rather than exact name is deliberate: a rename should
 * cost a missing utilization figure, not the whole panel.
 */
export function parseRocmSmi(stdout: string): GpuDevice[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const devices: GpuDevice[] = [];
  for (const [cardKey, raw] of Object.entries(parsed as Record<string, unknown>)) {
    const indexMatch = /(\d+)/.exec(cardKey);
    if (!indexMatch || !raw || typeof raw !== 'object') continue;
    const index = Number(indexMatch[1]);
    const fields = raw as Record<string, unknown>;
    const pick = (pattern: RegExp): string | undefined => {
      for (const [k, v] of Object.entries(fields)) {
        if (pattern.test(k) && (typeof v === 'string' || typeof v === 'number')) return String(v);
      }
      return undefined;
    };
    // rocm-smi reports VRAM in bytes already, unlike nvidia-smi's MiB.
    const total = bytes(pick(/vram.*total.*memory|vram_total(?!_used)/i));
    const used = bytes(pick(/vram.*(total.*)?used.*memory|vram_used/i));
    const name =
      pick(/card\s*series|card\s*model|device\s*name|product\s*name|market_name/i)?.trim() ||
      `GPU ${index}`;
    const util = pick(/gpu\s*use|gpu_use|gfx_activity|utilization/i);
    devices.push({
      index,
      name,
      memoryTotal: total,
      memoryUsed: used,
      utilization: util !== undefined ? percent(util) : undefined,
    });
  }
  return devices.sort((a, b) => a.index - b.index);
}

function bytes(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Apple Silicon has one GPU sharing the machine's single memory pool, so
 * there is no VRAM figure to read and no second card to split across —
 * reported as the unified total, explicitly flagged, so the UI can say that
 * instead of implying a dedicated pool. Intel Macs are skipped: their GPU is
 * a separate device whose memory `sysctl` knows nothing about.
 */
async function probeAppleMetal(): Promise<GpuDevice[]> {
  if (process.platform !== 'darwin' || os.arch() !== 'arm64') return [];
  const brand = (await run('sysctl', ['-n', 'machdep.cpu.brand_string']))?.trim();
  return [
    {
      index: 0,
      name: brand ? `${brand} GPU` : 'Apple Silicon GPU',
      memoryTotal: os.totalmem(),
      unified: true,
    },
  ];
}

/** First vendor tool that answers wins; NVIDIA first because it is the common case. */
export async function probeGpuDevices(): Promise<GpuProbeResult> {
  const nvidia = await run('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.used,utilization.gpu',
    '--format=csv,noheader,nounits',
  ]);
  if (nvidia) {
    const devices = parseNvidiaSmi(nvidia);
    if (devices.length) return { devices, source: 'nvidia-smi' };
  }

  const rocm = await run('rocm-smi', [
    '--showmeminfo',
    'vram',
    '--showuse',
    '--showproductname',
    '--json',
  ]);
  if (rocm) {
    const devices = parseRocmSmi(rocm);
    if (devices.length) return { devices, source: 'rocm-smi' };
  }

  const apple = await probeAppleMetal();
  if (apple.length) return { devices: apple, source: 'apple-metal' };

  return {
    devices: [],
    source: null,
    reason:
      'No GPU tool answered on the machine running this UI (tried nvidia-smi and rocm-smi). In Docker, per-card data needs the GPU passed into the container.',
  };
}

/** Loopback — i.e. Ollama is served by this same machine/container. */
export function isLocalHost(hostUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(hostUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '::1' || hostname === '0.0.0.0' || hostname === '::') return true;
  return /^127\./.test(hostname);
}

export type GpuProbeMode = 'auto' | 'always' | 'off';

/**
 * `OLLAMA_UI_GPU_PROBE` — `auto` (default) probes only when the active
 * Ollama host is loopback, which is the only case the local GPUs are
 * provably the ones Ollama is using. `always` is the escape hatch for
 * same-machine setups that still address Ollama by LAN IP or
 * `host.docker.internal`; `off` disables the probe entirely.
 */
export function gpuProbeMode(): GpuProbeMode {
  const raw = process.env.OLLAMA_UI_GPU_PROBE?.trim().toLowerCase();
  if (raw === 'always' || raw === 'on' || raw === '1') return 'always';
  if (raw === 'off' || raw === 'never' || raw === '0') return 'off';
  return 'auto';
}

/**
 * Whether a probe is allowed for this host, and if not, the sentence the UI
 * should show in place of the per-card panel. The explanation matters more
 * than it looks: "no per-card breakdown" with no reason reads like a bug,
 * and the actual reason is either a deliberate setting or a remote host.
 */
export function shouldProbe(
  hostUrl: string | null,
  mode: GpuProbeMode = gpuProbeMode(),
): { probe: boolean; reason?: string } {
  if (mode === 'off') {
    return { probe: false, reason: 'Per-GPU readout is disabled (OLLAMA_UI_GPU_PROBE=off).' };
  }
  if (mode === 'always') return { probe: true };
  if (!hostUrl) return { probe: false, reason: 'No active Ollama host configured.' };
  if (isLocalHost(hostUrl)) return { probe: true };
  let label = hostUrl;
  try {
    label = new URL(hostUrl).host;
  } catch {
    /* keep the raw string */
  }
  return {
    probe: false,
    reason:
      `Ollama runs on ${label}, not on the machine serving this UI, and its API reports only a ` +
      `total across all GPUs — so there is nothing to break down per card. Set ` +
      `OLLAMA_UI_GPU_PROBE=always if this UI does run on that same machine.`,
  };
}
