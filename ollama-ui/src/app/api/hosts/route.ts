import { NextRequest } from 'next/server';
import { addHost, listHosts, activateHost, deleteHost, getActiveHost, updateHost } from '@/lib/db';
import { validateHost } from '@/lib/env';

export const runtime = 'nodejs';

export async function GET() {
  const hosts = listHosts();
  return Response.json({ hosts, active: getActiveHost()?.id || null });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const urlRaw = String(body.url || '').trim();
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : undefined;
    const valid = validateHost(urlRaw);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid host URL' }), { status: 400 });
    }
    const row = addHost(valid, label);
    return Response.json({ host: row });
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: (e as Error).message || 'Error' }), {
      status: 500,
    });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const action = String(body.action || 'activate');
    const id = String(body.id || '').trim();
    if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
    if (action === 'activate') {
      const row = activateHost(id);
      if (!row) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      return Response.json({ active: row.id });
    } else if (action === 'update') {
      const patch: { url?: string; label?: string } = {};
      if (typeof body.url === 'string') {
        const v = body.url.trim();
        const valid = validateHost(v);
        if (!valid)
          return new Response(JSON.stringify({ error: 'Invalid host URL' }), { status: 400 });
        patch.url = valid;
      }
      if (typeof body.label === 'string') patch.label = body.label.trim().slice(0, 80);
      const row = updateHost(id, patch);
      if (!row) return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
      return Response.json({ host: row });
    } else {
      return new Response(JSON.stringify({ error: 'Unknown action' }), { status: 400 });
    }
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: (e as Error).message || 'Error' }), {
      status: 500,
    });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return new Response(JSON.stringify({ error: 'Missing id' }), { status: 400 });
    deleteHost(id);
    return Response.json({ ok: true });
  } catch (e: unknown) {
    return new Response(JSON.stringify({ error: (e as Error).message || 'Error' }), {
      status: 500,
    });
  }
}
