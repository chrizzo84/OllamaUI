import { NextRequest } from 'next/server';
import { getSetting, setSetting } from '@/lib/db';

const KEY = 'memory';

interface MemorySettings {
  memoryEnabled: boolean;
}

// Memory defaults to ON — unlike tools (which hit an external SearXNG
// instance), remembering facts is local-only and low-risk, and the whole
// point is that it works without the user having to discover a toggle first.
const DEFAULTS: MemorySettings = { memoryEnabled: true };

export async function GET() {
  const stored = getSetting<MemorySettings>(KEY);
  return Response.json({ ...DEFAULTS, ...stored, exists: !!stored });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const current = { ...DEFAULTS, ...getSetting<MemorySettings>(KEY) };
  const next: MemorySettings = {
    memoryEnabled:
      typeof body.memoryEnabled === 'boolean' ? body.memoryEnabled : current.memoryEnabled,
  };
  setSetting(KEY, next);
  return Response.json({ ...next, exists: true });
}
