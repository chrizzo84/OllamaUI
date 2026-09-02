import { NextRequest } from 'next/server';
import { getAttachmentMeta, readAttachment } from '@/lib/db';

export const runtime = 'nodejs';

/*
Serves an uploaded file (an image attached to a chat message) by its
content-addressed id.

Attachments used to be inlined into every message as base64, which meant the
bytes were re-sent on every session load and every search, and inflated the
database by roughly a third over the raw file size. Serving them from a
normal URL instead lets the browser cache them and lets a conversation load
without them.

Behind the password gate like everything else (see src/proxy.ts).
*/
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = getAttachmentMeta(id);
  const bytes = readAttachment(id);
  if (!meta || !bytes) return new Response('Not Found', { status: 404 });
  return new Response(new Uint8Array(bytes), {
    headers: {
      'Content-Type': meta.mime,
      'Content-Length': String(bytes.length),
      // The id IS the hash of the content, so a given URL can never return
      // different bytes — safe to cache indefinitely. Private: this is the
      // user's own chat content, not something a shared proxy should hold.
      'Cache-Control': 'private, max-age=31536000, immutable',
    },
  });
}
