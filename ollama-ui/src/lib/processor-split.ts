/**
 * The CPU/GPU memory split shown per model on the Running Models page.
 *
 * Ollama's `/api/ps` reports exactly two numbers per loaded model: `size`
 * (the whole resident footprint — weights, KV cache and compute buffers)
 * and `size_vram` (however much of that sits in video memory). `size_vram`
 * is the SUM over every device the runner was spread across — ollama's
 * `memoryParsingWriter` adds up one GPU buffer at a time and also keeps a
 * per-device map, but only the total leaves the process: neither
 * `/api/ps` nor any other HTTP route exposes the per-card breakdown (see
 * `vramByDevice` / `VRAMByGPU` in ollama's llm/llama_server.go, which the
 * scheduler uses internally). So the split below is already correct on a
 * multi-GPU box — it just cannot say *which* card holds what. Per-card
 * numbers come from src/lib/gpu-devices.ts instead, which asks the machine
 * directly.
 *
 * This lives in its own module rather than inside the page component so the
 * edge cases below can be tested; the page had them wrong, which is the
 * whole reason the module exists.
 */

export interface ProcessorSplit {
  /** Exact percentages (not rounded) — meant for bar widths. */
  cpuPct: number;
  gpuPct: number;
  /** Human label, e.g. `12% CPU / 88% GPU`. */
  label: string;
  /**
   * False when the two numbers can't be turned into a split at all: no
   * size reported yet (a model still loading), or more VRAM than total
   * footprint, which ollama's own `ollama ps` prints as "Unknown".
   */
  known: boolean;
}

const UNKNOWN: ProcessorSplit = { cpuPct: 0, gpuPct: 0, label: 'Unknown', known: false };

/**
 * Mirrors the PROCESSOR column of `ollama ps` (cmd/cmd.go), with one
 * deliberate difference: rounding is never allowed to erase a side of the
 * split. A 70B spread over two cards with 300 MB left on the CPU rounds to
 * 100% GPU, and reporting that as "100% GPU" hides the one thing the column
 * exists to reveal — that the model is *not* fully offloaded and every
 * token pays for it. Those cases read `<1% CPU / >99% GPU` instead, and
 * only a genuine `size_vram == size` (or `== 0`) gets a flat 100%.
 */
export function processorSplit(size: number | undefined, vram: number | undefined): ProcessorSplit {
  const total = size ?? 0;
  const onGpu = vram ?? 0;
  if (total <= 0) return UNKNOWN;
  // More in VRAM than resident in total is not a split, it's a contradiction
  // — don't present it as 100% GPU (which is what clamping used to do).
  if (onGpu > total) return UNKNOWN;
  if (onGpu <= 0) return { cpuPct: 100, gpuPct: 0, label: '100% CPU', known: true };
  if (onGpu === total) return { cpuPct: 0, gpuPct: 100, label: '100% GPU', known: true };

  const gpuPct = (onGpu / total) * 100;
  const cpuPct = 100 - gpuPct;
  const gpuRounded = Math.round(gpuPct);
  const gpuText = gpuRounded >= 100 ? '>99' : gpuRounded <= 0 ? '<1' : String(gpuRounded);
  const cpuText = gpuRounded >= 100 ? '<1' : gpuRounded <= 0 ? '>99' : String(100 - gpuRounded);
  return { cpuPct, gpuPct, label: `${cpuText}% CPU / ${gpuText}% GPU`, known: true };
}

/**
 * Totals across every loaded model, for the summary cards. `vram` is the
 * aggregate over all GPUs, because that is what ollama reports.
 * `unknownModels` counts the ones whose numbers didn't add up (see
 * processorSplit) — they are left out of both totals rather than silently
 * skewing them.
 */
export function memoryTotals(models: { size?: number; size_vram?: number }[]): {
  vram: number;
  ram: number;
  unknownModels: number;
} {
  let vram = 0;
  let ram = 0;
  let unknownModels = 0;
  for (const m of models) {
    const total = m.size ?? 0;
    const onGpu = m.size_vram ?? 0;
    if (total <= 0 || onGpu > total) {
      unknownModels++;
      continue;
    }
    vram += onGpu;
    ram += total - onGpu;
  }
  return { vram, ram, unknownModels };
}
