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
