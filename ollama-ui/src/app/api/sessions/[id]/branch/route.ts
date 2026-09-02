import { NextRequest } from 'next/server';
import { switchToVariant, listMessagesWithVariants } from '@/lib/db';

export const runtime = 'nodejs';

/*
POST { messageId } — show a different alternative at that point in the
conversation.

Regenerating an answer, or editing a question, no longer throws the previous
version away: it stores the new one beside the old one. This is how the UI
moves between them. The whole continuation of the chosen branch comes back
with it, so switching away and back is lossless rather than truncating the
conversation at the switch point.
*/
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const messageId = typeof body.messageId === 'string' ? body.messageId : '';
  if (!messageId) return Response.json({ error: 'messageId is required' }, { status: 400 });

  if (!switchToVariant(id, messageId)) {
    return Response.json({ error: 'No such message in this session' }, { status: 404 });
  }
  return Response.json({
    messages: [...listMessagesWithVariants(id, 'A'), ...listMessagesWithVariants(id, 'B')],
  });
}
