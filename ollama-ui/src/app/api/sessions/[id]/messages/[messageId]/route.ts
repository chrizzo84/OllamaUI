import { NextRequest } from 'next/server';
import { deleteMessageSubtree, listMessagesWithVariants } from '@/lib/db';

export const runtime = 'nodejs';

/*
DELETE one message and everything that followed from it.

Deleting used to be done by PATCHing the whole remaining history back from
the browser, which worked only because there was one linear history. Now
that regenerate and edit keep alternatives, that would have deleted every
branch the tab could not see. This removes exactly the subtree asked for.
*/
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; messageId: string }> },
) {
  const { id, messageId } = await params;
  if (!deleteMessageSubtree(id, messageId)) {
    return Response.json({ error: 'No such message in this session' }, { status: 404 });
  }
  return Response.json({
    messages: [...listMessagesWithVariants(id, 'A'), ...listMessagesWithVariants(id, 'B')],
  });
}
