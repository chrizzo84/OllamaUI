import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseNumCtx,
  MIN_NUM_CTX,
  MAX_NUM_CTX,
  DEFAULT_GENERATION_SETTINGS,
} from './generation-settings';

const getSetting = vi.fn();
vi.mock('@/lib/db', () => ({
  getSetting: (...args: unknown[]) => getSetting(...args),
  setSetting: vi.fn(),
}));

const { getEffectiveGenerationSettings, withDefaultNumCtx } =
  await import('./generation-settings-server');

beforeEach(() => getSetting.mockReset());

describe('parseNumCtx', () => {
  it('accepts a plain number', () => {
    expect(parseNumCtx(32768)).toBe(32768);
  });

  it('rounds a fractional value', () => {
    expect(parseNumCtx(4096.6)).toBe(4097);
  });

  // Clamps rather than rejects: this backs a number field and preset
  // buttons, where "too big" means the user wants the maximum, not that
  // their input should be discarded.
  it('clamps below the minimum and above the maximum', () => {
    expect(parseNumCtx(1)).toBe(MIN_NUM_CTX);
    expect(parseNumCtx(99_999_999)).toBe(MAX_NUM_CTX);
  });

  it('rejects anything that is not a finite number', () => {
    for (const v of ['16384', null, undefined, {}, NaN, Infinity]) {
      expect(parseNumCtx(v)).toBeNull();
    }
  });
});

describe('getEffectiveGenerationSettings', () => {
  it('falls back to the built-in default when nothing is stored', () => {
    getSetting.mockReturnValue(undefined);
    expect(getEffectiveGenerationSettings()).toEqual(DEFAULT_GENERATION_SETTINGS);
  });

  it('uses a stored value', () => {
    getSetting.mockReturnValue({ defaultNumCtx: 65536 });
    expect(getEffectiveGenerationSettings().defaultNumCtx).toBe(65536);
  });

  it('ignores a stored value that is not a usable number', () => {
    getSetting.mockReturnValue({ defaultNumCtx: 'lots' });
    expect(getEffectiveGenerationSettings().defaultNumCtx).toBe(
      DEFAULT_GENERATION_SETTINGS.defaultNumCtx,
    );
  });
});

/*
The whole point of the setting: Telegram and the scheduler pass no options at
all, so before this they ran at Ollama's own default no matter what the web
UI showed. An explicit num_ctx still has to win — that is the per-model pill,
a deliberate choice for one model.
*/
describe('withDefaultNumCtx', () => {
  beforeEach(() => getSetting.mockReturnValue({ defaultNumCtx: 32768 }));

  it('fills in the default when there are no options at all', () => {
    expect(withDefaultNumCtx(undefined)).toEqual({ num_ctx: 32768 });
  });

  it('fills in the default when options exist but say nothing about num_ctx', () => {
    expect(withDefaultNumCtx({ temperature: 0.2 })).toEqual({ temperature: 0.2, num_ctx: 32768 });
  });

  it('leaves an explicit num_ctx alone', () => {
    expect(withDefaultNumCtx({ num_ctx: 4096 })).toEqual({ num_ctx: 4096 });
  });

  it('replaces a non-numeric num_ctx rather than passing it upstream', () => {
    expect(withDefaultNumCtx({ num_ctx: 'big' })).toEqual({ num_ctx: 32768 });
  });

  it('does not mutate the caller’s options object', () => {
    const original = { temperature: 0.5 };
    withDefaultNumCtx(original);
    expect(original).toEqual({ temperature: 0.5 });
  });

  it('tolerates a non-object being passed as options', () => {
    expect(withDefaultNumCtx('nonsense')).toEqual({ num_ctx: 32768 });
    expect(withDefaultNumCtx(null)).toEqual({ num_ctx: 32768 });
  });
});
