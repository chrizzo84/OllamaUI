// Individual chat messages, the branch tree they form, and the writes that maintain it.
import { db, dbInstance, writeAttachment, sniffImageMime } from './connection';
import type { ChatMessage } from '@/store/chat';
import { getSession } from './sessions';

// --- Chat Messages ---

type Column = 'A' | 'B';

interface MessageDbRow {
  id: string;
  session_id: string;
  parent_id: string | null;
  column_key: string;
  role: string;
  content: string;
  model: string | null;
  raw: string | null;
  trace: string | null;
  stats: string | null;
  attachments: string;
  created_at: number;
}

function rowToMessage(r: MessageDbRow): ChatMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as ChatMessage['role'],
    content: r.content,
    createdAt: r.created_at,
    ...(r.column_key === 'B' ? { column: 'B' as const } : {}),
    ...(r.model ? { model: r.model } : {}),
    ...(r.raw ? { raw: r.raw } : {}),
    ...(r.trace ? { trace: JSON.parse(r.trace) } : {}),
    ...(r.stats ? { stats: JSON.parse(r.stats) } : {}),
    ...(r.attachments && r.attachments !== '[]'
      ? { attachments: JSON.parse(r.attachments) as string[] }
      : {}),
  };
}

function headColumnField(column: Column): 'head_a' | 'head_b' {
  return column === 'B' ? 'head_b' : 'head_a';
}

/*
The conversation as currently shown: the path from the root down to the
column's active leaf, oldest first. Walking parent links up from the head
and reversing is O(depth) and touches only the messages actually on screen,
so sibling branches left behind by a regenerate cost nothing to carry.

Falls back to "every message in the column, in creation order" when the
head pointer is missing — which is what a session written before heads
existed looks like if its migration was interrupted.
*/
export function listMessages(sessionId: string, column: Column = 'A'): ChatMessage[] {
  const session = getSession(sessionId);
  if (!session) return [];
  const head = column === 'B' ? session.headB : session.headA;
  if (!head) {
    const rows = db
      .prepare(
        'SELECT * FROM messages WHERE session_id = ? AND column_key = ? ORDER BY created_at ASC',
      )
      .all(sessionId, column) as unknown as MessageDbRow[];
    return rows.map(rowToMessage);
  }

  const byId = new Map<string, MessageDbRow>();
  const rows = db
    .prepare('SELECT * FROM messages WHERE session_id = ? AND column_key = ?')
    .all(sessionId, column) as unknown as MessageDbRow[];
  for (const r of rows) byId.set(r.id, r);

  const path: MessageDbRow[] = [];
  const seen = new Set<string>();
  let cursor: string | null = head;
  while (cursor) {
    const row: MessageDbRow | undefined = byId.get(cursor);
    // seen: a corrupted parent cycle must not hang the request.
    if (!row || seen.has(cursor)) break;
    seen.add(cursor);
    path.push(row);
    cursor = row.parent_id;
  }
  return path.reverse().map(rowToMessage);
}

/*
The visible conversation plus, on each message that has alternatives, the
information the UI needs to offer a switcher. Loaded in one pass over the
column rather than a query per message.
*/
export function listMessagesWithVariants(
  sessionId: string,
  column: Column = 'A',
): Array<ChatMessage & { variants?: MessageVariants }> {
  const visible = listMessages(sessionId, column);
  if (visible.length === 0) return [];

  const all = db
    .prepare(
      'SELECT id, parent_id, created_at FROM messages WHERE session_id = ? AND column_key = ?',
    )
    .all(sessionId, column) as unknown as Array<{
    id: string;
    parent_id: string | null;
    created_at: number;
  }>;

  const byParent = new Map<string, Array<{ id: string; created_at: number }>>();
  for (const r of all) {
    const key = r.parent_id ?? '\u0000root';
    const bucket = byParent.get(key);
    if (bucket) bucket.push(r);
    else byParent.set(key, [r]);
  }
  for (const bucket of byParent.values()) bucket.sort((a, b) => a.created_at - b.created_at);

  const parentOf = new Map(all.map((r) => [r.id, r.parent_id]));
  return visible.map((m) => {
    const bucket = byParent.get(parentOf.get(m.id) ?? '\u0000root');
    if (!bucket || bucket.length < 2) return m;
    const ids = bucket.map((r) => r.id);
    return { ...m, variants: { index: ids.indexOf(m.id), total: ids.length, ids } };
  });
}

// Both columns at once, as one flat array — the shape the chat UI and the
// export/compaction paths already work in.
export function listAllMessages(sessionId: string): ChatMessage[] {
  return [...listMessages(sessionId, 'A'), ...listMessages(sessionId, 'B')];
}

/*
Attachment ids for a message being written.

Inline base64 `images` are normalised into stored attachments here, at the
single point every write path goes through, rather than at each caller. That
matters because the browser's own copy of a message keeps its base64 for the
lifetime of the tab: a later full-history write (compaction, undo, delete)
resends the old shape, and without this the message would come back with its
pictures silently dropped. Storage is content-addressed, so re-submitting
the same bytes is idempotent and costs nothing.
*/
function resolveAttachments(m: ChatMessage): string[] {
  if (m.attachments?.length) return m.attachments;
  if (!m.images?.length) return [];
  return m.images
    .map((b64) => {
      try {
        const bytes = Buffer.from(b64, 'base64');
        return bytes.length ? writeAttachment(dbInstance(), bytes, sniffImageMime(bytes)).id : null;
      } catch {
        return null;
      }
    })
    .filter((id): id is string => !!id);
}

function insertMessageRow(m: ChatMessage, sessionId: string, parentId: string | null): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages
       (id, session_id, parent_id, column_key, role, content, model, raw, trace, stats, attachments, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    m.id,
    sessionId,
    parentId,
    m.column === 'B' ? 'B' : 'A',
    m.role,
    m.content ?? '',
    m.model ?? null,
    m.raw ?? null,
    m.trace ? JSON.stringify(m.trace) : null,
    m.stats ? JSON.stringify(m.stats) : null,
    JSON.stringify(resolveAttachments(m)),
    m.createdAt ?? Date.now(),
  );
}

/*
Appends messages that aren't stored yet and patches the ones that are,
chaining each new message onto the column's current head and advancing that
head. This is the normal "user sent something, the assistant replied" write
path, and it never rewrites a message it wasn't given.
*/
export interface UpsertOptions {
  /*
  Attach the first new message here instead of at the end of the thread.

  This is what turns "regenerate" from destruction into branching: the new
  assistant reply is attached to the *user message* that prompted it, so the
  previous reply stays in the tree as its sibling rather than being deleted
  to make room.
  */
  parentMessageId?: string | null;
  /*
  Attach the first new message wherever the named message is attached,
  making the two siblings. Used when editing a user message: the rewritten
  question becomes an alternative to the original, not a replacement.

  Takes precedence over parentMessageId when both are given.
  */
  siblingOfMessageId?: string;
}

export function upsertMessages(
  sessionId: string,
  incoming: ChatMessage[],
  options: UpsertOptions = {},
): boolean {
  const session = getSession(sessionId);
  if (!session) return false;

  const heads: Record<Column, string | null> = { A: session.headA, B: session.headB };
  const exists = db.prepare('SELECT id, parent_id FROM messages WHERE id = ?');

  let explicitParent: string | null | undefined;
  if (options.siblingOfMessageId) {
    const sibling = exists.get(options.siblingOfMessageId) as
      { parent_id: string | null } | undefined;
    // A sibling target that no longer exists falls through to normal
    // appending rather than silently starting a detached thread.
    if (sibling) explicitParent = sibling.parent_id;
  } else if (options.parentMessageId !== undefined) {
    explicitParent = options.parentMessageId;
  }

  let previousId: string | null | undefined;
  for (const m of incoming) {
    const column: Column = m.column === 'B' ? 'B' : 'A';
    const known = exists.get(m.id) as { id: string; parent_id: string | null } | undefined;
    if (known) {
      // Already stored: keep its place in the tree, refresh its content.
      insertMessageRow(m, sessionId, known.parent_id);
      previousId = m.id;
      continue;
    }
    /*
    Parent precedence: the message written just before this one in the same
    call, then any explicit branch target, then the column's current head.

    Chaining within the call matters for the ordinary send, where the user
    message and the empty assistant placeholder arrive together: the
    assistant must hang off the user message, not off whatever the head was
    before either existed.
    */
    const parent =
      previousId !== undefined && previousId !== null
        ? previousId
        : explicitParent !== undefined
          ? explicitParent
          : heads[column];
    insertMessageRow(m, sessionId, parent);
    heads[column] = m.id;
    previousId = m.id;
  }

  db.prepare('UPDATE sessions SET head_a = ?, head_b = ?, updated_at = ? WHERE id = ?').run(
    heads.A,
    heads.B,
    Date.now(),
    sessionId,
  );
  return true;
}

/*
Sibling alternatives of a message: every message sharing its parent, in
creation order, with the position of this one among them.

A message with no alternatives returns total 1, which is how the UI decides
whether to show the "‹ 2 / 3 ›" switcher at all.
*/
export interface MessageVariants {
  index: number;
  total: number;
  ids: string[];
}

export function variantsOf(messageId: string): MessageVariants | null {
  const row = db
    .prepare('SELECT parent_id, session_id, column_key FROM messages WHERE id = ?')
    .get(messageId) as
    { parent_id: string | null; session_id: string; column_key: string } | undefined;
  if (!row) return null;
  const siblings = db
    .prepare(
      row.parent_id === null
        ? 'SELECT id FROM messages WHERE session_id = ? AND column_key = ? AND parent_id IS NULL ORDER BY created_at ASC'
        : 'SELECT id FROM messages WHERE session_id = ? AND column_key = ? AND parent_id = ? ORDER BY created_at ASC',
    )
    .all(
      ...(row.parent_id === null
        ? [row.session_id, row.column_key]
        : [row.session_id, row.column_key, row.parent_id]),
    ) as unknown as Array<{ id: string }>;
  const ids = siblings.map((r) => r.id);
  return { index: ids.indexOf(messageId), total: ids.length, ids };
}

/*
Makes `messageId` the visible one among its siblings, by pointing the
column's head at the end of that branch.

Descends from the chosen message picking the newest child at each step,
which restores the continuation that branch had when it was last active
rather than truncating the conversation at the switch point.
*/
export function switchToVariant(sessionId: string, messageId: string): boolean {
  const row = db
    .prepare('SELECT id, column_key FROM messages WHERE id = ? AND session_id = ?')
    .get(messageId, sessionId) as { id: string; column_key: string } | undefined;
  if (!row) return false;

  const newestChild = db.prepare(
    'SELECT id FROM messages WHERE parent_id = ? ORDER BY created_at DESC LIMIT 1',
  );
  let leaf = messageId;
  const seen = new Set<string>([leaf]);
  for (;;) {
    const child = newestChild.get(leaf) as { id: string } | undefined;
    // seen: a corrupted cycle must not spin here forever.
    if (!child || seen.has(child.id)) break;
    seen.add(child.id);
    leaf = child.id;
  }

  const column: Column = row.column_key === 'B' ? 'B' : 'A';
  db.prepare(`UPDATE sessions SET ${headColumnField(column)} = ?, updated_at = ? WHERE id = ?`).run(
    leaf,
    Date.now(),
    sessionId,
  );
  return true;
}

// One message by id, wherever it lives — used by the callers that only need
// the finished text of a generation they just ran.
export function getMessage(id: string): ChatMessage | undefined {
  const r = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageDbRow | undefined;
  return r ? rowToMessage(r) : undefined;
}

// Patches one already-stored message in place (the final content/trace/stats
// of a finished generation). Silently does nothing if it's gone — the
// session may have been deleted mid-generation.
export function patchMessage(
  messageId: string,
  patch: { content?: string; trace?: unknown; stats?: unknown; raw?: string },
): void {
  const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
    MessageDbRow | undefined;
  if (!row) return;
  db.prepare('UPDATE messages SET content=?, trace=?, stats=?, raw=? WHERE id=?').run(
    patch.content ?? row.content,
    patch.trace === undefined ? row.trace : patch.trace ? JSON.stringify(patch.trace) : null,
    patch.stats === undefined ? row.stats : patch.stats ? JSON.stringify(patch.stats) : null,
    patch.raw === undefined ? row.raw : (patch.raw ?? null),
    messageId,
  );
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), row.session_id);
}

/*
Deletes a message and everything descended from it, in either direction of
branching — the "delete this exchange" action.

Only the subtree goes: sibling branches at the same point, and everything
above, are untouched. Doing this as a full-history rewrite from the browser
(which is how it used to work) would have quietly taken every other branch
in the session with it, since the browser only knows the path it can see.

The head is repaired afterwards if it pointed into what was removed.
*/
export function deleteMessageSubtree(sessionId: string, messageId: string): boolean {
  const root = db
    .prepare('SELECT id, column_key FROM messages WHERE id = ? AND session_id = ?')
    .get(messageId, sessionId) as { id: string; column_key: string } | undefined;
  if (!root) return false;

  const children = db.prepare('SELECT id FROM messages WHERE parent_id = ?');
  const doomed = new Set<string>([messageId]);
  const queue = [messageId];
  while (queue.length) {
    const current = queue.shift()!;
    for (const c of children.all(current) as unknown as Array<{ id: string }>) {
      if (doomed.has(c.id)) continue; // cycle guard
      doomed.add(c.id);
      queue.push(c.id);
    }
  }

  const remove = db.prepare('DELETE FROM messages WHERE id = ?');
  for (const id of doomed) remove.run(id);

  const column: Column = root.column_key === 'B' ? 'B' : 'A';
  const session = getSession(sessionId)!;
  const head = column === 'B' ? session.headB : session.headA;
  if (head && doomed.has(head)) {
    // Fall back to the newest message left in the column; null if it is now
    // empty. listMessages then shows that branch from its root.
    const survivor = db
      .prepare(
        'SELECT id FROM messages WHERE session_id = ? AND column_key = ? ORDER BY created_at DESC LIMIT 1',
      )
      .get(sessionId, column) as { id: string } | undefined;
    db.prepare(
      `UPDATE sessions SET ${headColumnField(column)} = ?, updated_at = ? WHERE id = ?`,
    ).run(survivor?.id ?? null, Date.now(), sessionId);
  }
  return true;
}

/*
Replaces a column's visible history wholesale — used by context compaction,
which legitimately rewrites the past into a summary. Everything previously
in the column is deleted rather than branched: unlike a regenerate, the
whole point is that the old messages are gone.
*/
export function replaceMessages(
  sessionId: string,
  messages: ChatMessage[],
  column: Column = 'A',
): boolean {
  const session = getSession(sessionId);
  if (!session) return false;
  db.prepare('DELETE FROM messages WHERE session_id = ? AND column_key = ?').run(sessionId, column);
  let parent: string | null = null;
  for (const m of messages) {
    insertMessageRow({ ...m, column: column === 'B' ? 'B' : undefined }, sessionId, parent);
    parent = m.id;
  }
  db.prepare(`UPDATE sessions SET ${headColumnField(column)} = ?, updated_at = ? WHERE id = ?`).run(
    parent,
    Date.now(),
    sessionId,
  );
  return true;
}

/*
Replaces a session's entire history from one flat array covering both
compare columns — the shape the browser holds and PATCHes back.

Each message is filed by its own `column` field. Partitioning matters: the
array arrives flattened, so treating it as a single column would file
column B's messages under A and delete B outright. A session that never used
compare mode simply has an empty B partition, which correctly clears a
column that is already empty.
*/
export function replaceAllMessages(sessionId: string, messages: ChatMessage[]): boolean {
  if (!getSession(sessionId)) return false;
  const columnA = messages.filter((m) => m.column !== 'B');
  const columnB = messages.filter((m) => m.column === 'B');
  replaceMessages(sessionId, columnA, 'A');
  replaceMessages(sessionId, columnB, 'B');
  return true;
}
