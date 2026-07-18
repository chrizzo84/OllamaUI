import { NextRequest } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const KEY = 'tools';

interface ToolsSettings {
  toolsEnabled: boolean;
  searxngTemplate: string;
}

const DEFAULTS: ToolsSettings = { toolsEnabled: false, searxngTemplate: '' };

export async function GET() {
  const stored = getSetting<ToolsSettings>(KEY);
  return Response.json({ ...DEFAULTS, ...stored, exists: !!stored });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const current = { ...DEFAULTS, ...getSetting<ToolsSettings>(KEY) };
  const next: ToolsSettings = {
    toolsEnabled: typeof body.toolsEnabled === 'boolean' ? body.toolsEnabled : current.toolsEnabled,
    searxngTemplate:
      typeof body.searxngTemplate === 'string' ? body.searxngTemplate : current.searxngTemplate,
  };
  setSetting(KEY, next);
  return Response.json({ ...next, exists: true });
}
