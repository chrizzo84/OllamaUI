import { getPref, setPref } from '@/lib/db';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

// GET /api/prefs
// Returns all preferences from the database.
export async function GET() {
  try {
    const requireDeleteConfirm = (getPref('requireDeleteConfirm') ?? 'true') === 'true';
    const autoRefreshModelsSeconds = Number(getPref('autoRefreshModelsSeconds') ?? '0');
    const searxngUrl = getPref('searxngUrl') ?? '';
    const searchLimit = Number(getPref('searchLimit') ?? '5');

    return NextResponse.json({
      requireDeleteConfirm,
      autoRefreshModelsSeconds,
      searxngUrl,
      searchLimit,
    });
  } catch (e) {
    console.error(e);
    return new Response('Error fetching preferences', { status: 500 });
  }
}

// POST /api/prefs
// Updates one or more preferences in the database.
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Record<string, unknown>;

    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') {
        setPref(key, value);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        setPref(key, String(value));
      }
    }

    return new Response('OK', { status: 200 });
  } catch (e) {
    console.error(e);
    return new Response('Error updating preferences', { status: 500 });
  }
}
