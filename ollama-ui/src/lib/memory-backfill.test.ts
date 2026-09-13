import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
Against a real database: what is being tested is which messages the backfill
picks up and that it never picks one up twice, and both are queries.
*/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-ui-backfill-test-'));
process.env.OLLAMA_UI_DATA_DIR = tmpDir;

const db = await import('./db');
const backfill = await import('./memory-backfill');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  for (const s of db.listSessions()) db.deleteSession(s.id);
  db.clearScanHistory();
});

/*
Messages are inserted one call at a time rather than as a batch: upsertMessages
chains each new message onto the conversation's current head, which is what
builds the parent links the backfill reads to find the reply a message
answers. Inserting them all at once would still chain them, but doing it turn
by turn is how a real conversation arrives.
*/
function conversation(turns: { role: 'user' | 'assistant'; content: string }[]) {
  const session = db.createSession({});
  const ids: string[] = [];
  turns.forEach((t, i) => {
    const id = `m${i}-${session.id}`;
    db.upsertMessages(session.id, [
      { id, role: t.role, content: t.content, createdAt: Date.now() + i },
    ]);
    ids.push(id);
  });
  return { session, ids };
}

describe('listUnscannedMessages', () => {
  it('finds user messages and ignores assistant replies', () => {
    conversation([
      { role: 'user', content: 'Ich nutze einen Homeserver' },
      { role: 'assistant', content: 'Verstanden.' },
    ]);
    const found = db.listUnscannedMessages();
    expect(found).toHaveLength(1);
    expect(found[0].content).toContain('Homeserver');
  });

  /**
   * Facts arrive in the order they became true, so processing them in order
   * lets a later one supersede an earlier one exactly as it would have live.
   * Newest-first would leave the outdated version standing as current.
   */
  it('returns them oldest first', () => {
    conversation([
      { role: 'user', content: 'erste Nachricht über etwas' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'zweite Nachricht über etwas' },
    ]);
    const found = db.listUnscannedMessages();
    expect(found[0].content).toContain('erste');
    expect(found[1].content).toContain('zweite');
  });

  // History is a tree: the message a user message hangs off is the reply it
  // followed, which stays correct once a conversation has branches.
  it('carries the reply the message answers', () => {
    conversation([
      { role: 'user', content: 'Wo wohne ich?' },
      { role: 'assistant', content: 'Das weiß ich nicht. Wo denn?' },
      { role: 'user', content: 'Musterstadt' },
    ]);
    const last = db.listUnscannedMessages().find((c) => c.content === 'Musterstadt');
    expect(last?.priorAssistantText).toContain('Wo denn?');
  });

  it('has no prior reply for the first message of a conversation', () => {
    conversation([{ role: 'user', content: 'Hallo, ich bin neu hier' }]);
    expect(db.listUnscannedMessages()[0].priorAssistantText).toBeNull();
  });

  it('skips empty messages', () => {
    conversation([
      { role: 'user', content: '   ' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'etwas mit Inhalt' },
    ]);
    expect(db.listUnscannedMessages()).toHaveLength(1);
  });
});

describe('listUnscannedConversations', () => {
  /**
   * Measured before switching to this: on the same ten-turn conversation a
   * local 35B model found one fact message-by-message across five calls, and
   * three from the transcript in a single call. Context the per-message pass
   * cannot have, at a fifth of the cost.
   */
  it('groups a conversation into one unit of work', () => {
    conversation([
      { role: 'user', content: 'Ich baue an einem lokalen Chat-Frontend' },
      { role: 'assistant', content: 'Worauf läuft das?' },
      { role: 'user', content: 'Auf einem Homeserver im Keller' },
    ]);
    const convos = db.listUnscannedConversations();
    expect(convos).toHaveLength(1);
    expect(convos[0].messageIds).toHaveLength(2);
  });

  // The whole exchange goes to the model, not just the unexamined half —
  // that is where the extra facts come from.
  it('includes the assistant turns as context', () => {
    conversation([
      { role: 'user', content: 'Ich baue an einem lokalen Chat-Frontend' },
      { role: 'assistant', content: 'Worauf läuft das?' },
      { role: 'user', content: 'Auf einem Homeserver im Keller' },
    ]);
    const [convo] = db.listUnscannedConversations();
    expect(convo.turns).toHaveLength(3);
    expect(convo.turns.some((t) => t.role === 'assistant')).toBe(true);
  });

  it('keeps separate conversations separate, oldest first', () => {
    conversation([{ role: 'user', content: 'erstes Gespräch über etwas' }]);
    conversation([{ role: 'user', content: 'zweites Gespräch über etwas' }]);
    const convos = db.listUnscannedConversations();
    expect(convos).toHaveLength(2);
    expect(convos[0].turns[0].content).toContain('erstes');
  });

  /**
   * A conversation that grows after being read comes back for its new
   * messages only — with the whole transcript as context, so the model still
   * sees what came before.
   */
  it('returns a conversation again when it gains a new message', () => {
    const { session } = conversation([
      { role: 'user', content: 'Ich baue an einem lokalen Chat-Frontend' },
      { role: 'assistant', content: 'Verstanden.' },
    ]);
    for (const id of db.listUnscannedConversations()[0].messageIds) db.markMessageScanned(id, 0);
    expect(db.listUnscannedConversations()).toHaveLength(0);

    db.upsertMessages(session.id, [
      {
        id: 'later',
        role: 'user',
        content: 'Übrigens wohne ich in Musterstadt',
        createdAt: Date.now() + 99,
      },
    ]);
    const again = db.listUnscannedConversations();
    expect(again).toHaveLength(1);
    expect(again[0].messageIds).toEqual(['later']);
    expect(again[0].turns.length).toBeGreaterThan(1);
  });

  it('counts conversations and messages separately', () => {
    conversation([
      { role: 'user', content: 'erste Nachricht über etwas' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'zweite Nachricht über etwas' },
    ]);
    expect(db.countUnscannedConversations()).toBe(1);
    expect(db.countUnscannedMessages()).toBe(2);
  });
});

describe('scan marks', () => {
  /**
   * Each candidate costs a model call, so a stopped or crashed run must not
   * start over — this is what makes the backfill resumable.
   */
  it('a scanned message is not offered again', () => {
    conversation([{ role: 'user', content: 'Ich nutze einen Homeserver' }]);
    const [first] = db.listUnscannedMessages();
    db.markMessageScanned(first.messageId, 1);
    expect(db.listUnscannedMessages()).toHaveLength(0);
    expect(db.countUnscannedMessages()).toBe(0);
    expect(db.countScannedMessages()).toBe(1);
  });

  // "Nothing here" is an answer, and re-reading the message would cost the
  // same nothing again.
  it('also remembers a message that yielded nothing', () => {
    conversation([{ role: 'user', content: 'danke!' }]);
    const [first] = db.listUnscannedMessages();
    db.markMessageScanned(first.messageId, 0);
    expect(db.listUnscannedMessages()).toHaveLength(0);
  });

  it('marking twice does not duplicate the record', () => {
    conversation([{ role: 'user', content: 'Ich nutze einen Homeserver' }]);
    const [first] = db.listUnscannedMessages();
    db.markMessageScanned(first.messageId, 1);
    db.markMessageScanned(first.messageId, 2);
    expect(db.countScannedMessages()).toBe(1);
  });

  it('clearing the history offers everything again', () => {
    conversation([{ role: 'user', content: 'Ich nutze einen Homeserver' }]);
    db.markMessageScanned(db.listUnscannedMessages()[0].messageId, 1);
    db.clearScanHistory();
    expect(db.listUnscannedMessages()).toHaveLength(1);
  });

  it('counts what is left to do', () => {
    conversation([
      { role: 'user', content: 'erste Nachricht über etwas' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'zweite Nachricht über etwas' },
    ]);
    expect(db.countUnscannedMessages()).toBe(2);
    db.markMessageScanned(db.listUnscannedMessages()[0].messageId, 0);
    expect(db.countUnscannedMessages()).toBe(1);
  });

  // Deleting a conversation must not leave its scan marks behind.
  it('forgets the marks of a deleted session', () => {
    const { session } = conversation([{ role: 'user', content: 'Ich nutze einen Homeserver' }]);
    db.markMessageScanned(db.listUnscannedMessages()[0].messageId, 1);
    db.deleteSession(session.id);
    expect(db.countScannedMessages()).toBe(0);
  });
});

/*
The run itself, with the model faked.

These cover the difference that turned out to matter most in practice: a call
that failed and a conversation that genuinely held nothing both used to arrive
as "found 0", and the second one retires the messages for good. A history read
by a broken run cannot be read again, so the distinction is not cosmetic.
*/
describe('a run against a model that answers badly', () => {
  const realFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  /** Waits for the detached run to settle, so assertions see a finished pass. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 200 && backfill.getBackfillProgress().status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  function respond(body: unknown, status = 200) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
  }

  it('stops and keeps the conversation unread when Ollama refuses', async () => {
    conversation([{ role: 'user', content: 'Ich habe einen Homeserver mit 128 GB RAM.' }]);
    // What a local Ollama actually answers for a model whose template has no
    // tool support — the failure that looked like "nothing found" forever.
    respond({ error: 'registry.ollama.ai/library/x does not support tools' }, 400);

    expect(backfill.startBackfill({ base: 'http://127.0.0.1:1', model: 'x' })).toBe(true);
    await settle();

    const progress = backfill.getBackfillProgress();
    expect(progress.status).toBe('error');
    expect(progress.error).toContain('400');
    // The point of the whole exercise: nothing was retired.
    expect(db.countScannedMessages()).toBe(0);
    expect(db.countUnscannedMessages()).toBe(1);
  });

  it('records an unreachable host as an error rather than an empty result', async () => {
    conversation([{ role: 'user', content: 'Ich habe einen Homeserver mit 128 GB RAM.' }]);
    globalThis.fetch = (async () => {
      throw new Error('fetch failed');
    }) as typeof fetch;

    backfill.startBackfill({ base: 'http://127.0.0.1:1', model: 'x' });
    await settle();

    expect(backfill.getBackfillProgress().status).toBe('error');
    expect(db.countScannedMessages()).toBe(0);
  });

  it('marks a conversation read once the model has actually answered', async () => {
    conversation([{ role: 'user', content: 'Ich habe einen Homeserver mit 128 GB RAM.' }]);
    respond({
      message: {
        tool_calls: [
          {
            function: {
              name: 'remember_fact',
              arguments: {
                fact: 'Der Nutzer hat einen Homeserver mit 128 GB RAM.',
                type: 'identity',
              },
            },
          },
        ],
      },
    });

    backfill.startBackfill({ base: 'http://127.0.0.1:1', model: 'x' });
    await settle();

    const progress = backfill.getBackfillProgress();
    expect(progress.status).toBe('done');
    expect(progress.found).toBe(1);
    expect(db.countUnscannedMessages()).toBe(0);
    expect(db.listMemories().some((m) => m.content.includes('128 GB RAM'))).toBe(true);
  });

  // "Read it, there was nothing" is a real verdict and has to stick, or every
  // pass re-reads the same small talk for ever.
  it('marks a conversation read when the model finds nothing', async () => {
    conversation([{ role: 'user', content: 'Erklär mir bitte kurz, wie Transformer arbeiten.' }]);
    respond({ message: { content: 'NONE' } });

    backfill.startBackfill({ base: 'http://127.0.0.1:1', model: 'x' });
    await settle();

    expect(backfill.getBackfillProgress().status).toBe('done');
    expect(db.countUnscannedMessages()).toBe(0);
  });
});
