import { describe, it, expect } from 'vitest';
import {
  TOOL_KEYS,
  TOOL_NAMES,
  TOOL_LABELS,
  DEFAULT_TOOL_TOGGLES,
  anyToolEnabled,
  disabledToolNames,
  type ToolToggles,
} from './tool-settings';

const allOff = (): ToolToggles =>
  Object.fromEntries(TOOL_KEYS.map((k) => [k, false])) as ToolToggles;

describe('tool settings tables', () => {
  it('defines a function name for every key', () => {
    for (const key of TOOL_KEYS) expect(TOOL_NAMES[key]).toBeTruthy();
  });

  it('defines a label for every key', () => {
    for (const key of TOOL_KEYS) {
      expect(TOOL_LABELS[key]?.title).toBeTruthy();
      expect(TOOL_LABELS[key]?.description).toBeTruthy();
    }
  });

  it('defines a default for every key', () => {
    for (const key of TOOL_KEYS) expect(typeof DEFAULT_TOOL_TOGGLES[key]).toBe('boolean');
  });

  it('has no duplicate function names', () => {
    const names = TOOL_KEYS.map((k) => TOOL_NAMES[k]);
    expect(new Set(names).size).toBe(names.length);
  });

  it('uses snake_case function names, matching what the model is shown', () => {
    for (const key of TOOL_KEYS) expect(TOOL_NAMES[key]).toMatch(/^[a-z][a-z0-9_]*$/);
  });

  it('does not list remember_fact — memory has its own settings section', () => {
    expect(Object.values(TOOL_NAMES)).not.toContain('remember_fact');
  });

  it('defaults every tool to on', () => {
    for (const key of TOOL_KEYS) expect(DEFAULT_TOOL_TOGGLES[key]).toBe(true);
  });
});

describe('anyToolEnabled', () => {
  it('is true for the defaults', () => {
    expect(anyToolEnabled(DEFAULT_TOOL_TOGGLES)).toBe(true);
  });

  it('is false when everything is off', () => {
    expect(anyToolEnabled(allOff())).toBe(false);
  });

  it('is true when a single tool remains on', () => {
    expect(anyToolEnabled({ ...allOff(), calculator: true })).toBe(true);
  });
});

describe('disabledToolNames', () => {
  it('is empty for the defaults', () => {
    expect(disabledToolNames(DEFAULT_TOOL_TOGGLES)).toEqual([]);
  });

  it('returns the model-facing function name, not the settings key', () => {
    expect(disabledToolNames({ ...DEFAULT_TOOL_TOGGLES, webSearch: false })).toEqual([
      'web_search',
    ]);
  });

  it('lists every tool when all are off', () => {
    expect(disabledToolNames(allOff()).sort()).toEqual(TOOL_KEYS.map((k) => TOOL_NAMES[k]).sort());
  });
});
