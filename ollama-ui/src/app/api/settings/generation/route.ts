import { NextRequest } from 'next/server';
import { setSetting } from '@/lib/db';
import { parseNumCtx } from '@/lib/generation-settings';
import {
  GENERATION_SETTINGS_KEY,
  getEffectiveGenerationSettings,
} from '@/lib/generation-settings-server';

export const runtime = 'nodejs';

/*
GET/PUT the global generation defaults (Settings → Generation). Stored in the
same `settings` table as the tool toggles, so the value is shared across
browsers and readable from every place a generation runs — see
withDefaultNumCtx in generation-settings-server.ts.
*/
export async function GET() {
  const current = getEffectiveGenerationSettings();
  return Response.json({ ...current });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const current = getEffectiveGenerationSettings();
  const next = { defaultNumCtx: parseNumCtx(body.defaultNumCtx) ?? current.defaultNumCtx };
  setSetting(GENERATION_SETTINGS_KEY, next);
  return Response.json({ ...next });
}
