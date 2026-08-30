// Single source of truth for the individually-toggleable tools (Settings →
// Tools) — shared by the settings API route, the client-side store, and
// every place that actually runs a generation (api/chat/route.ts,
// scheduler.ts, telegram-bridge.ts), so a tool disabled here is disabled
// everywhere, not just in the web UI. No server-only imports, safe to pull
// into client bundles too.
//
// remember_fact is NOT here — it already has its own richer settings
// section (Settings → Memory: global + per-chat override, view/manage
// stored facts), gated by `memoryEnabled` rather than this list.
export const TOOL_KEYS = [
  'webSearch',
  'getCurrentDate',
  'getWeather',
  'calculator',
  'createReminder',
  'createRecurringTask',
] as const;

export type ToolKey = (typeof TOOL_KEYS)[number];

export type ToolToggles = Record<ToolKey, boolean>;

// The key here is the Settings-page/store name; the value is the actual
// function name the model calls (and what generation-runner.ts's
// `excludeTools` filters on).
export const TOOL_NAMES: Record<ToolKey, string> = {
  webSearch: 'web_search',
  getCurrentDate: 'get_current_date',
  getWeather: 'get_weather',
  calculator: 'calculator',
  createReminder: 'create_reminder',
  createRecurringTask: 'create_recurring_task',
};

export const TOOL_LABELS: Record<ToolKey, { title: string; description: string }> = {
  webSearch: { title: 'Web search', description: 'Search the web via a SearXNG instance.' },
  getCurrentDate: {
    title: 'Current date/time',
    description: 'Look up today’s real date instead of guessing.',
  },
  getWeather: {
    title: 'Weather forecast',
    description: 'Real multi-day forecasts via Open-Meteo (no API key needed).',
  },
  calculator: {
    title: 'Calculator',
    description: 'Evaluate arithmetic expressions reliably instead of doing math in its head.',
  },
  createReminder: {
    title: 'Create reminder',
    description: 'Schedule a one-off reminder for a specific future moment, from chat.',
  },
  createRecurringTask: {
    title: 'Create recurring task',
    description: 'Schedule a repeating prompt (e.g. "every morning at 8"), from chat.',
  },
};

// Default: every tool on — the assistant can use anything unless you turn
// something off, rather than an opt-in list.
export const DEFAULT_TOOL_TOGGLES: ToolToggles = {
  webSearch: true,
  getCurrentDate: true,
  getWeather: true,
  calculator: true,
  createReminder: true,
  createRecurringTask: true,
};

export function anyToolEnabled(toggles: ToolToggles): boolean {
  return TOOL_KEYS.some((k) => toggles[k]);
}

// Tool function names to hide (feed straight into GenerationParams'
// `excludeTools`) for whichever of these have been turned off.
export function disabledToolNames(toggles: ToolToggles): string[] {
  return TOOL_KEYS.filter((k) => !toggles[k]).map((k) => TOOL_NAMES[k]);
}
