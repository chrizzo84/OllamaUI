import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { validateHost, resolveOllamaHost } from '@/lib/env';

export const runtime = 'edge';

export async function GET(req: NextRequest) {
  const current = resolveOllamaHost(req);
  return Response.json({ host: current });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const candidate = typeof body.host === 'string' ? body.host : '';
    const valid = validateHost(candidate);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid host URL' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const c = await cookies();
    c.set('ollama_host', valid, {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 7,
    });
    return Response.json({ host: valid });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
