import { NextRequest } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';
import { TOOL_KEYS, DEFAULT_TOOL_TOGGLES, type ToolToggles } from '@/lib/tool-settings';

const KEY = 'tools';

interface ToolsSettings extends ToolToggles {
  searxngTemplate: string;
}

const DEFAULTS: ToolsSettings = { ...DEFAULT_TOOL_TOGGLES, searxngTemplate: '' };

export async function GET() {
  const stored = getSetting<ToolsSettings>(KEY);
  return Response.json({ ...DEFAULTS, ...stored, exists: !!stored });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const current: ToolsSettings = { ...DEFAULTS, ...getSetting<ToolsSettings>(KEY) };
  const next: ToolsSettings = { ...current };
  for (const key of TOOL_KEYS) {
    if (typeof body[key] === 'boolean') next[key] = body[key];
  }
  if (typeof body.searxngTemplate === 'string') next.searxngTemplate = body.searxngTemplate;
  setSetting(KEY, next);
  return Response.json({ ...next, exists: true });
}
