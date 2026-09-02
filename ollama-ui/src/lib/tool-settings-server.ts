// Server-side reader for the per-tool Settings → Tools toggles (see
// src/lib/tool-settings.ts for the shared shape/defaults). Split out from
// that file because it needs db.ts (node:sqlite), which can't go into a
// module shared with client bundles.
import { getSetting } from '@/lib/db';
import { DEFAULT_TOOL_TOGGLES, disabledToolNames, type ToolToggles } from '@/lib/tool-settings';

interface StoredToolsSettings extends ToolToggles {
  searxngTemplate: string;
}

export function getEffectiveToolToggles(): ToolToggles {
  const stored = getSetting<StoredToolsSettings>('tools');
  return { ...DEFAULT_TOOL_TOGGLES, ...stored };
}

// Tool function names currently turned off — feed straight into
// GenerationParams' `excludeTools` (merge with any context-specific
// exclusions a caller already has, e.g. scheduler.ts hiding create_reminder
// during a reminder's own delivery).
export function getGloballyDisabledToolNames(): string[] {
  return disabledToolNames(getEffectiveToolToggles());
}

/*
The SearXNG endpoint the web_search tool should use, or null for the
server-side default (SEARXNG_HOST).

This used to arrive as an `x-searxng-endpoint-template` request header set
by the browser, which meant any caller could hand the server an arbitrary
URL to fetch and read the response back through a chat reply — a server-side
request forgery hole. The value was already persisted server-side (Settings
-> Tools writes it here, and both the scheduler and the Telegram bridge
always read it from here since they have no request to carry a header on),
so the header was duplicating stored state as well as widening the attack
surface. Reading it here makes the stored setting the single source for
every caller.
*/
export function getEffectiveSearxngTemplate(): string | null {
  const stored = getSetting<StoredToolsSettings>('tools');
  const template = stored?.searxngTemplate?.trim();
  return template || null;
}
