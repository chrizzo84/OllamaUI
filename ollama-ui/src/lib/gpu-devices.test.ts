import { describe, it, expect } from 'vitest';
import { parseNvidiaSmi, parseRocmSmi, isLocalHost, shouldProbe } from './gpu-devices';

const MIB = 1024 * 1024;

describe('parseNvidiaSmi', () => {
  // Real `nvidia-smi --query-gpu=index,name,memory.total,memory.used,utilization.gpu
  // --format=csv,noheader,nounits` output shape, two cards.
  const twoCards = `0, NVIDIA GeForce RTX 3090, 24576, 23109, 98
1, NVIDIA GeForce RTX 3090, 24576, 1204, 3
`;

  it('parses every card, not just the first', () => {
    const devices = parseNvidiaSmi(twoCards);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      index: 0,
      name: 'NVIDIA GeForce RTX 3090',
      memoryTotal: 24576 * MIB,
      memoryUsed: 23109 * MIB,
      utilization: 98,
    });
    expect(devices[1].memoryUsed).toBe(1204 * MIB);
  });

  it('sorts by device index regardless of output order', () => {
    const devices = parseNvidiaSmi('1, GPU B, 8192, 100, 0\n0, GPU A, 8192, 200, 0\n');
    expect(devices.map((d) => d.index)).toEqual([0, 1]);
  });

  it('keeps a product name that contains commas intact', () => {
    const devices = parseNvidiaSmi('0, NVIDIA RTX A6000, Ada Generation, 49140, 512, 12\n');
    expect(devices[0].name).toBe('NVIDIA RTX A6000, Ada Generation');
    expect(devices[0].memoryTotal).toBe(49140 * MIB);
    expect(devices[0].utilization).toBe(12);
  });

  // A field the driver can't answer must stay absent rather than become 0,
  // which would render as a card with no memory at all.
  it('leaves [N/A] fields undefined', () => {
    const devices = parseNvidiaSmi('0, Tesla T4, 15360, [N/A], [N/A]\n');
    expect(devices[0].memoryTotal).toBe(15360 * MIB);
    expect(devices[0].memoryUsed).toBeUndefined();
    expect(devices[0].utilization).toBeUndefined();
  });

  it('ignores blank lines and unparseable rows', () => {
    expect(parseNvidiaSmi('\n\nNVIDIA-SMI has failed\n')).toEqual([]);
    expect(parseNvidiaSmi('')).toEqual([]);
  });
});

describe('parseRocmSmi', () => {
  const twoCards = JSON.stringify({
    card0: {
      'Card series': 'Radeon RX 7900 XTX',
      'VRAM Total Memory (B)': '25753026560',
      'VRAM Total Used Memory (B)': '20401094656',
      'GPU use (%)': '91',
    },
    card1: {
      'Card series': 'Radeon RX 7900 XTX',
      'VRAM Total Memory (B)': '25753026560',
      'VRAM Total Used Memory (B)': '1073741824',
      'GPU use (%)': '0',
    },
  });

  it('parses both cards with bytes already in bytes', () => {
    const devices = parseRocmSmi(twoCards);
    expect(devices).toHaveLength(2);
    expect(devices[0]).toEqual({
      index: 0,
      name: 'Radeon RX 7900 XTX',
      memoryTotal: 25753026560,
      memoryUsed: 20401094656,
      utilization: 91,
    });
    expect(devices[1].memoryUsed).toBe(1073741824);
  });

  it('accepts the card:N key spelling some builds use', () => {
    const devices = parseRocmSmi(
      JSON.stringify({ 'card:1': { 'VRAM Total Memory (B)': '8589934592' } }),
    );
    expect(devices[0].index).toBe(1);
    expect(devices[0].name).toBe('GPU 1');
    expect(devices[0].memoryUsed).toBeUndefined();
  });

  // Field names have been renamed across ROCm releases; a rename should cost
  // one figure, not the whole panel.
  it('still finds memory under alternative field names', () => {
    const devices = parseRocmSmi(
      JSON.stringify({ card0: { vram_total: '8589934592', vram_used: '1073741824' } }),
    );
    expect(devices[0].memoryTotal).toBe(8589934592);
    expect(devices[0].memoryUsed).toBe(1073741824);
  });

  it('returns nothing for non-JSON output', () => {
    expect(parseRocmSmi('ERROR: rocm-smi not supported')).toEqual([]);
  });
});

describe('isLocalHost', () => {
  it('recognises loopback hosts', () => {
    for (const url of [
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'http://127.1.2.3:11434',
      'http://[::1]:11434',
      'http://0.0.0.0:11434',
    ]) {
      expect(isLocalHost(url), url).toBe(true);
    }
  });

  it('rejects remote hosts and garbage', () => {
    for (const url of [
      'http://192.0.2.10:11434',
      'https://ollama.example.com',
      'http://host.docker.internal:11434',
      'not a url',
    ]) {
      expect(isLocalHost(url), url).toBe(false);
    }
  });
});

describe('shouldProbe', () => {
  it('probes a loopback host in auto mode', () => {
    expect(shouldProbe('http://localhost:11434', 'auto').probe).toBe(true);
  });

  // The guard that matters: probing the UI machine's GPUs while Ollama runs
  // elsewhere would caption the wrong hardware as that server's usage.
  it('refuses a remote host in auto mode and names it', () => {
    const r = shouldProbe('http://192.0.2.10:11434', 'auto');
    expect(r.probe).toBe(false);
    expect(r.reason).toContain('192.0.2.10:11434');
    expect(r.reason).toContain('OLLAMA_UI_GPU_PROBE=always');
  });

  it('probes a remote host when explicitly told to', () => {
    expect(shouldProbe('http://192.0.2.10:11434', 'always').probe).toBe(true);
  });

  it('never probes when switched off, and explains why', () => {
    const r = shouldProbe('http://localhost:11434', 'off');
    expect(r.probe).toBe(false);
    expect(r.reason).toContain('OLLAMA_UI_GPU_PROBE=off');
  });

  it('refuses when no host is configured', () => {
    expect(shouldProbe(null, 'auto').probe).toBe(false);
  });
});
