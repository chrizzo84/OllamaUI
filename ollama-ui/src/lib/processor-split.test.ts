import { describe, it, expect } from 'vitest';
import { processorSplit, memoryTotals } from './processor-split';

describe('processorSplit', () => {
  it('reports a fully offloaded model as 100% GPU', () => {
    const s = processorSplit(8_000_000_000, 8_000_000_000);
    expect(s).toMatchObject({ gpuPct: 100, cpuPct: 0, label: '100% GPU', known: true });
  });

  it('reports a model with no VRAM as 100% CPU', () => {
    const s = processorSplit(8_000_000_000, 0);
    expect(s).toMatchObject({ gpuPct: 0, cpuPct: 100, label: '100% CPU', known: true });
  });

  it('treats a missing size_vram the same as zero', () => {
    expect(processorSplit(8_000_000_000, undefined).label).toBe('100% CPU');
  });

  it('splits a partial offload', () => {
    const s = processorSplit(10_000, 7_500);
    expect(s.gpuPct).toBeCloseTo(75);
    expect(s.cpuPct).toBeCloseTo(25);
    expect(s.label).toBe('25% CPU / 75% GPU');
  });

  // The bug this module was extracted for: a 70B spread across two cards with
  // a sliver left on the CPU rounded to 100% and was labelled "100% GPU",
  // hiding the partial offload that makes every token slower.
  it('never rounds a partial offload up to 100% GPU', () => {
    const s = processorSplit(40_000_000_000, 39_900_000_000);
    expect(s.known).toBe(true);
    expect(s.label).toBe('<1% CPU / >99% GPU');
    expect(s.gpuPct).toBeLessThan(100);
    expect(s.cpuPct).toBeGreaterThan(0);
  });

  it('never rounds a sliver of GPU offload down to 100% CPU', () => {
    const s = processorSplit(40_000_000_000, 100_000_000);
    expect(s.label).toBe('>99% CPU / <1% GPU');
    expect(s.gpuPct).toBeGreaterThan(0);
  });

  // `ollama ps` prints "Unknown" for these rather than inventing a split.
  it('is unknown when more VRAM than total size is reported', () => {
    const s = processorSplit(1_000, 2_000);
    expect(s).toMatchObject({ known: false, label: 'Unknown' });
  });

  it('is unknown when no size is reported yet', () => {
    expect(processorSplit(0, 0).known).toBe(false);
    expect(processorSplit(undefined, undefined).known).toBe(false);
  });
});

describe('memoryTotals', () => {
  // size_vram is Ollama's sum over every GPU the model was placed on, so
  // multi-GPU models are already fully counted — there is no per-card data in
  // /api/ps to add up.
  it('adds VRAM and the system-RAM remainder across models', () => {
    const t = memoryTotals([
      { size: 10_000, size_vram: 10_000 }, // fully on GPU(s)
      { size: 8_000, size_vram: 6_000 }, // partial offload
      { size: 4_000, size_vram: 0 }, // CPU only
    ]);
    expect(t.vram).toBe(16_000);
    expect(t.ram).toBe(2_000 + 4_000);
    expect(t.unknownModels).toBe(0);
  });

  it('excludes contradictory models from both totals instead of skewing them', () => {
    const t = memoryTotals([
      { size: 10_000, size_vram: 10_000 },
      { size: 1_000, size_vram: 5_000 },
      { size: 0, size_vram: 0 },
    ]);
    expect(t.vram).toBe(10_000);
    expect(t.ram).toBe(0);
    expect(t.unknownModels).toBe(2);
  });

  it('handles an empty list', () => {
    expect(memoryTotals([])).toEqual({ vram: 0, ram: 0, unknownModels: 0 });
  });
});
