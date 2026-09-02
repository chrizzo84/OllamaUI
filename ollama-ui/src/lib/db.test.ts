import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ChatMessage } from '@/store/chat';

/*
These run against a real SQLite file in a throwaway directory (never the
app's own data/), because the things worth testing here — the FTS triggers,
the parent-chain walk, attachment content addressing — are behaviours of
SQLite itself, not of code that could be meaningfully faked.

db.ts reads OLLAMA_UI_DATA_DIR once at module load, so each test file gets
one directory and the module is imported after the env var is set.
*/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-ui-db-test-'));
process.env.OLLAMA_UI_DATA_DIR = tmpDir;

const db = await import('./db');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const msg = (over: Partial<ChatMessage> & { id: string }): ChatMessage => ({
  role: 'user',
  content: '',
  createdAt: Date.now(),
  ...over,
});

function freshSession() {
  return db.createSession({});
}

beforeEach(() => {
  for (const s of db.listSessions()) db.deleteSession(s.id);
});

describe('sessions', () => {
  it('creates a session with empty heads', () => {
    const s = freshSession();
    expect(s.headA).toBeNull();
    expect(s.headB).toBeNull();
    expect(db.listMessages(s.id)).toEqual([]);
  });

  it('deletes a session and its messages together', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1', content: 'hi' })]);
    db.deleteSession(s.id);
    expect(db.getSession(s.id)).toBeUndefined();
    expect(db.getMessage('m1')).toBeUndefined();
  });

  it('reports message counts without loading bodies', () => {
    const a = freshSession();
    const b = freshSession();
    db.upsertMessages(a.id, [msg({ id: 'a1' }), msg({ id: 'a2' })]);
    db.upsertMessages(b.id, [msg({ id: 'b1' })]);
    const counts = db.messageCountsBySession();
    expect(counts.get(a.id)).toBe(2);
    expect(counts.get(b.id)).toBe(1);
  });
});

describe('upsertMessages', () => {
  it('appends in order and advances the head', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [
      msg({ id: 'm1', content: 'first' }),
      msg({ id: 'm2', role: 'assistant', content: 'second' }),
    ]);
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['first', 'second']);
    expect(db.getSession(s.id)!.headA).toBe('m2');
  });

  it('appends across separate calls, chaining onto the stored head', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1', content: 'one' })]);
    db.upsertMessages(s.id, [msg({ id: 'm2', content: 'two' })]);
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('patches an existing message without moving it or duplicating it', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1', content: 'a' }), msg({ id: 'm2', content: 'b' })]);
    db.upsertMessages(s.id, [msg({ id: 'm1', content: 'edited' })]);
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['edited', 'b']);
  });

  it('keeps the two compare columns as independent threads', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [
      msg({ id: 'a1', content: 'colA' }),
      msg({ id: 'b1', content: 'colB', column: 'B' }),
    ]);
    expect(db.listMessages(s.id, 'A').map((m) => m.content)).toEqual(['colA']);
    expect(db.listMessages(s.id, 'B').map((m) => m.content)).toEqual(['colB']);
    const stored = db.getSession(s.id)!;
    expect(stored.headA).toBe('a1');
    expect(stored.headB).toBe('b1');
  });

  it('returns false for a session that does not exist', () => {
    expect(db.upsertMessages('nope', [msg({ id: 'x' })])).toBe(false);
  });

  it('round-trips trace, stats, model and attachments', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [
      msg({
        id: 'm1',
        role: 'assistant',
        content: 'answer',
        model: 'qwen3:8b',
        trace: [{ type: 'thinking', id: 't1', text: 'hm' }],
        stats: { promptTokens: 5, completionTokens: 7, tokensPerSecond: 2 },
        attachments: ['abc'],
      }),
    ]);
    const [m] = db.listMessages(s.id);
    expect(m.model).toBe('qwen3:8b');
    expect(m.trace).toEqual([{ type: 'thinking', id: 't1', text: 'hm' }]);
    expect(m.stats?.tokensPerSecond).toBe(2);
    expect(m.attachments).toEqual(['abc']);
  });

  it('omits absent optional fields rather than storing nulls', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1', content: 'plain' })]);
    const [m] = db.listMessages(s.id);
    expect(m).not.toHaveProperty('model');
    expect(m).not.toHaveProperty('trace');
    expect(m).not.toHaveProperty('attachments');
  });
});

describe('patchMessage', () => {
  it('updates content in place', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1', role: 'assistant', content: '' })]);
    db.patchMessage('m1', { content: 'final answer' });
    expect(db.getMessage('m1')!.content).toBe('final answer');
  });

  it('leaves untouched fields alone', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1', role: 'assistant', content: 'x', model: 'm' })]);
    db.patchMessage('m1', { content: 'y' });
    expect(db.getMessage('m1')!.model).toBe('m');
  });

  it('is a no-op for a message that no longer exists', () => {
    expect(() => db.patchMessage('gone', { content: 'x' })).not.toThrow();
  });
});

describe('replaceMessages', () => {
  it('replaces the column wholesale, as compaction needs', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1' }), msg({ id: 'm2' }), msg({ id: 'm3' })]);
    db.replaceMessages(s.id, [msg({ id: 'sum', role: 'system', content: 'summary' })]);
    expect(db.listMessages(s.id).map((m) => m.id)).toEqual(['sum']);
    expect(db.getMessage('m1')).toBeUndefined();
  });

  it('leaves the other column untouched', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'a1' }), msg({ id: 'b1', column: 'B' })]);
    db.replaceMessages(s.id, [msg({ id: 'a2' })], 'A');
    expect(db.listMessages(s.id, 'B').map((m) => m.id)).toEqual(['b1']);
  });

  it('clears the head when replacing with nothing', () => {
    const s = freshSession();
    db.upsertMessages(s.id, [msg({ id: 'm1' })]);
    db.replaceMessages(s.id, []);
    expect(db.getSession(s.id)!.headA).toBeNull();
    expect(db.listMessages(s.id)).toEqual([]);
  });
});

describe('attachments', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

  it('is content-addressed: the same bytes store once', () => {
    const a = db.saveAttachment(Buffer.from(png));
    const b = db.saveAttachment(Buffer.from(png));
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives different bytes different ids', () => {
    expect(db.saveAttachment(png).id).not.toBe(db.saveAttachment(jpeg).id);
  });

  it('sniffs the real image type instead of assuming PNG', () => {
    expect(db.saveAttachment(png).mime).toBe('image/png');
    expect(db.saveAttachment(jpeg).mime).toBe('image/jpeg');
  });

  it('prefers an explicitly supplied mime type', () => {
    expect(db.saveAttachment(png, 'image/apng').mime).toBe('image/apng');
  });

  it('reads the exact bytes back', () => {
    const { id } = db.saveAttachment(jpeg);
    expect(db.readAttachment(id)!.equals(jpeg)).toBe(true);
  });

  it('exposes metadata', () => {
    const { id } = db.saveAttachment(png);
    const meta = db.getAttachmentMeta(id)!;
    expect(meta.byteSize).toBe(png.length);
    expect(meta.mime).toBe('image/png');
  });

  it('refuses an id that is not a hash — no path traversal', () => {
    expect(db.readAttachment('../../app.db')).toBeNull();
    expect(db.readAttachment('..%2Fapp.db')).toBeNull();
    expect(db.readAttachment('')).toBeNull();
  });

  it('returns null for an unknown but well-formed id', () => {
    expect(db.readAttachment('a'.repeat(64))).toBeNull();
  });

  it('rehydrates ids into base64 for the upstream request', () => {
    const { id } = db.saveAttachment(jpeg);
    expect(db.attachmentsAsBase64([id])).toEqual([jpeg.toString('base64')]);
  });

  it('skips ids it cannot read rather than failing the whole message', () => {
    const { id } = db.saveAttachment(jpeg);
    expect(db.attachmentsAsBase64(['b'.repeat(64), id])).toHaveLength(1);
  });

  it('returns an empty list for a message with no attachments', () => {
    expect(db.attachmentsAsBase64(undefined)).toEqual([]);
    expect(db.attachmentsAsBase64([])).toEqual([]);
  });
});

describe('searchMessages', () => {
  function seed() {
    const s = db.createSession({});
    db.updateSession(s.id, { title: 'Weather planning', titleStatus: 'ready' });
    db.upsertMessages(s.id, [
      msg({ id: 'q1', content: 'Wie wird das Wetter in Donaueschingen?' }),
      msg({ id: 'a1', role: 'assistant', content: 'Morgen scheint die Sonne, 22 Grad.' }),
    ]);
    return s;
  }

  it('finds a message by a word in its body', () => {
    const s = seed();
    const hits = db.searchMessages('Sonne');
    expect(hits.map((h) => h.sessionId)).toContain(s.id);
    expect(hits[0].snippet).toContain('Sonne');
  });

  it('finds a session by its title', () => {
    const s = seed();
    const hits = db.searchMessages('Weather');
    expect(hits.some((h) => h.sessionId === s.id && h.matchField === 'title')).toBe(true);
  });

  it('matches the last word as a prefix, so results appear while typing', () => {
    seed();
    expect(db.searchMessages('Donauesch')).not.toHaveLength(0);
  });

  it('ignores diacritics, so "Munchen" finds "München"', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'd1', content: 'Grüße aus München' })]);
    expect(db.searchMessages('Munchen')).not.toHaveLength(0);
    // Folding covers accents only: ß is a distinct letter, not a decorated
    // s, so "Grusse" is genuinely a different word to the tokenizer.
    expect(db.searchMessages('Grüße')).not.toHaveLength(0);
  });

  it('is case-insensitive', () => {
    seed();
    expect(db.searchMessages('SONNE')).not.toHaveLength(0);
  });

  it('returns one hit per session, not one per matching message', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [
      msg({ id: 'r1', content: 'repeat repeat' }),
      msg({ id: 'r2', content: 'repeat again' }),
    ]);
    expect(db.searchMessages('repeat').filter((h) => h.sessionId === s.id)).toHaveLength(1);
  });

  it('keeps the index in sync when a message is edited', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'e1', content: 'aardvark' })]);
    db.patchMessage('e1', { content: 'zebra' });
    expect(db.searchMessages('aardvark')).toHaveLength(0);
    expect(db.searchMessages('zebra')).not.toHaveLength(0);
  });

  it('keeps the index in sync when a session is deleted', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'x1', content: 'ephemeral' })]);
    db.deleteSession(s.id);
    expect(db.searchMessages('ephemeral')).toHaveLength(0);
  });

  it.each([
    ['AND OR NOT', 'bare boolean operators'],
    ['"unbalanced', 'an unbalanced quote'],
    ['foo(bar', 'an unbalanced paren'],
    ['a*b^c:d', 'operator characters'],
    ['NEAR(a b)', 'a NEAR expression'],
    ['*', 'a lone wildcard'],
  ])('treats %s literally instead of throwing (%s)', (query) => {
    // A search box must never turn a keystroke into a 500.
    expect(() => db.searchMessages(query)).not.toThrow();
  });

  it('returns nothing for an empty query', () => {
    expect(db.searchMessages('   ')).toEqual([]);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 8; i++) {
      const s = db.createSession({});
      db.upsertMessages(s.id, [msg({ id: `lim${i}`, content: 'needle in haystack' })]);
    }
    expect(db.searchMessages('needle', 3)).toHaveLength(3);
  });
});

describe('replaceAllMessages', () => {
  it('files each message by its own column instead of collapsing them', () => {
    // The browser PATCHes one flat array covering both compare columns.
    const s = db.createSession({});
    db.replaceAllMessages(s.id, [
      msg({ id: 'a1', content: 'left' }),
      msg({ id: 'b1', content: 'right', column: 'B' }),
      msg({ id: 'a2', content: 'left two' }),
    ]);
    expect(db.listMessages(s.id, 'A').map((m) => m.content)).toEqual(['left', 'left two']);
    expect(db.listMessages(s.id, 'B').map((m) => m.content)).toEqual(['right']);
  });

  it('clears a column that the new history no longer contains', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'b1', column: 'B' })]);
    db.replaceAllMessages(s.id, [msg({ id: 'a1' })]);
    expect(db.listMessages(s.id, 'B')).toEqual([]);
    expect(db.getSession(s.id)!.headB).toBeNull();
  });

  it('returns false for an unknown session', () => {
    expect(db.replaceAllMessages('nope', [])).toBe(false);
  });
});

describe('inline images are normalised on write', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);

  it('turns base64 images into stored attachments', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'i1', images: [png.toString('base64')] })]);
    const [m] = db.listMessages(s.id);
    expect(m.attachments).toHaveLength(1);
    expect(m).not.toHaveProperty('images');
    expect(db.readAttachment(m.attachments![0])!.equals(png)).toBe(true);
  });

  it('keeps pictures when the browser resends its own stale base64 copy', () => {
    // The tab holds base64 for the life of the session; a later full-history
    // write (compaction, undo, delete) resends that shape. Without
    // normalisation on every write path the images would silently vanish.
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'i1', images: [png.toString('base64')] })]);
    const storedId = db.listMessages(s.id)[0].attachments![0];
    db.replaceAllMessages(s.id, [msg({ id: 'i1', images: [png.toString('base64')] })]);
    expect(db.listMessages(s.id)[0].attachments).toEqual([storedId]);
  });

  it('prefers existing attachment ids over re-encoding', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'i1', attachments: ['deadbeef'], images: ['ignored'] })]);
    expect(db.listMessages(s.id)[0].attachments).toEqual(['deadbeef']);
  });

  it('drops unreadable base64 rather than failing the write', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'i1', content: 'hi', images: [''] })]);
    expect(db.listMessages(s.id)[0].content).toBe('hi');
  });
});

describe('branching', () => {
  // Sets up: user "q" -> assistant "a1", then a regenerate producing "a2"
  // as a1's sibling.
  function withTwoAnswers() {
    const s = db.createSession({});
    db.upsertMessages(s.id, [
      msg({ id: 'q', content: 'question' }),
      msg({ id: 'a1', role: 'assistant', content: 'first answer' }),
    ]);
    db.upsertMessages(s.id, [msg({ id: 'a2', role: 'assistant', content: 'second answer' })], {
      parentMessageId: 'q',
    });
    return s;
  }

  it('keeps the previous answer instead of destroying it', () => {
    const s = withTwoAnswers();
    expect(db.getMessage('a1')).toBeDefined();
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['question', 'second answer']);
  });

  it('reports the sibling count on the visible message', () => {
    const s = withTwoAnswers();
    const shown = db.listMessagesWithVariants(s.id);
    expect(shown[0].variants).toBeUndefined(); // the question has no alternatives
    expect(shown[1].variants).toEqual({ index: 1, total: 2, ids: ['a1', 'a2'] });
  });

  it('switches back to the earlier answer', () => {
    const s = withTwoAnswers();
    expect(db.switchToVariant(s.id, 'a1')).toBe(true);
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['question', 'first answer']);
  });

  it('restores a branch together with everything that followed it', () => {
    const s = withTwoAnswers();
    // Continue the conversation on the a1 branch, then leave and come back.
    db.switchToVariant(s.id, 'a1');
    db.upsertMessages(s.id, [
      msg({ id: 'q2', content: 'follow-up' }),
      msg({ id: 'a3', role: 'assistant', content: 'follow-up answer' }),
    ]);
    db.switchToVariant(s.id, 'a2');
    expect(db.listMessages(s.id).map((m) => m.id)).toEqual(['q', 'a2']);
    db.switchToVariant(s.id, 'a1');
    expect(db.listMessages(s.id).map((m) => m.id)).toEqual(['q', 'a1', 'q2', 'a3']);
  });

  it('treats an edited question as a sibling of the original', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [
      msg({ id: 'q1', content: 'original question' }),
      msg({ id: 'a1', role: 'assistant', content: 'answer' }),
    ]);
    db.upsertMessages(
      s.id,
      [
        msg({ id: 'q2', content: 'edited question' }),
        msg({ id: 'a2', role: 'assistant', content: 'new answer' }),
      ],
      { siblingOfMessageId: 'q1' },
    );
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['edited question', 'new answer']);
    const shown = db.listMessagesWithVariants(s.id);
    expect(shown[0].variants).toEqual({ index: 1, total: 2, ids: ['q1', 'q2'] });
  });

  it('branches at the root correctly (first message edited)', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'r1', content: 'v1' })]);
    db.upsertMessages(s.id, [msg({ id: 'r2', content: 'v2' })], { siblingOfMessageId: 'r1' });
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['v2']);
    expect(db.variantsOf('r1')).toEqual({ index: 0, total: 2, ids: ['r1', 'r2'] });
  });

  it('falls back to appending when the sibling target is gone', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'm1', content: 'one' })]);
    db.upsertMessages(s.id, [msg({ id: 'm2', content: 'two' })], {
      siblingOfMessageId: 'never-existed',
    });
    expect(db.listMessages(s.id).map((m) => m.content)).toEqual(['one', 'two']);
  });

  it('reports no variants for a message with none', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [msg({ id: 'solo' })]);
    expect(db.variantsOf('solo')).toEqual({ index: 0, total: 1, ids: ['solo'] });
  });

  it('returns null for a message that does not exist', () => {
    expect(db.variantsOf('ghost')).toBeNull();
  });

  it('refuses to switch to a message from another session', () => {
    const a = withTwoAnswers();
    const b = db.createSession({});
    expect(db.switchToVariant(b.id, 'a1')).toBe(false);
    expect(db.getSession(a.id)!.headA).toBe('a2');
  });

  it('keeps branches per column in compare mode', () => {
    const s = db.createSession({});
    db.upsertMessages(s.id, [
      msg({ id: 'qa', content: 'q' }),
      msg({ id: 'aa', role: 'assistant', content: 'A answer' }),
      msg({ id: 'qb', content: 'q', column: 'B' }),
      msg({ id: 'ab', role: 'assistant', content: 'B answer', column: 'B' }),
    ]);
    db.upsertMessages(s.id, [msg({ id: 'aa2', role: 'assistant', content: 'A again' })], {
      parentMessageId: 'qa',
    });
    expect(db.listMessages(s.id, 'A').map((m) => m.content)).toEqual(['q', 'A again']);
    expect(db.listMessages(s.id, 'B').map((m) => m.content)).toEqual(['q', 'B answer']);
  });
});

describe('evaluation sets', () => {
  it('creates and lists a set', () => {
    const set = db.upsertEvalSet({ name: 'German summaries', prompts: ['Fasse X zusammen'] });
    expect(db.listEvalSets().some((s) => s.id === set.id)).toBe(true);
    expect(db.getEvalSet(set.id)!.prompts).toEqual(['Fasse X zusammen']);
  });

  it('updates a set in place, keeping its id and creation time', () => {
    const set = db.upsertEvalSet({ name: 'a', prompts: ['one'] });
    const updated = db.upsertEvalSet({ id: set.id, name: 'b', prompts: ['one', 'two'] });
    expect(updated.id).toBe(set.id);
    expect(updated.created_at).toBe(set.created_at);
    expect(db.getEvalSet(set.id)!.prompts).toHaveLength(2);
  });

  it('deletes a set', () => {
    const set = db.upsertEvalSet({ name: 'temp', prompts: ['x'] });
    db.deleteEvalSet(set.id);
    expect(db.getEvalSet(set.id)).toBeUndefined();
  });
});

describe('evaluation runs', () => {
  function runWithResults() {
    const set = db.upsertEvalSet({ name: 'set', prompts: ['p1', 'p2'] });
    const run = db.createEvalRun({ setId: set.id, setName: set.name, models: ['m1', 'm2'] });
    db.recordEvalResult({
      runId: run.id,
      promptIndex: 0,
      prompt: 'p1',
      model: 'm1',
      content: 'answer a',
      error: null,
      tokensPerSecond: 42.5,
      durationMs: 1200,
    });
    db.recordEvalResult({
      runId: run.id,
      promptIndex: 0,
      prompt: 'p1',
      model: 'm2',
      content: '',
      error: 'model not found',
      tokensPerSecond: null,
      durationMs: 90,
    });
    return run;
  }

  it('starts as running and can be finished', () => {
    const run = runWithResults();
    expect(db.getEvalRun(run.id)!.status).toBe('running');
    db.finishEvalRun(run.id);
    const done = db.getEvalRun(run.id)!;
    expect(done.status).toBe('done');
    expect(done.finished_at).toBeGreaterThan(0);
  });

  it('records answers and failures side by side', () => {
    const results = db.listEvalResults(runWithResults().id);
    expect(results).toHaveLength(2);
    const ok = results.find((r) => r.model === 'm1')!;
    const failed = results.find((r) => r.model === 'm2')!;
    expect(ok.content).toBe('answer a');
    expect(ok.tokensPerSecond).toBe(42.5);
    // A failed model records why rather than vanishing from the matrix.
    expect(failed.error).toBe('model not found');
  });

  it('starts every result unrated — "not judged" is distinct from "bad"', () => {
    expect(db.listEvalResults(runWithResults().id).every((r) => r.rating === null)).toBe(true);
  });

  it('stores and clears a rating', () => {
    const run = runWithResults();
    const [first] = db.listEvalResults(run.id);
    expect(db.rateEvalResult(first.id, 4)).toBe(true);
    expect(db.listEvalResults(run.id).find((r) => r.id === first.id)!.rating).toBe(4);
    db.rateEvalResult(first.id, null);
    expect(db.listEvalResults(run.id).find((r) => r.id === first.id)!.rating).toBeNull();
  });

  it('reports an unknown result rather than silently succeeding', () => {
    expect(db.rateEvalResult('ghost', 3)).toBe(false);
  });

  it('orders results by prompt then model, so the grid is stable', () => {
    const set = db.upsertEvalSet({ name: 's', prompts: ['a', 'b'] });
    const run = db.createEvalRun({ setId: set.id, setName: 's', models: ['zeta', 'alpha'] });
    for (const [i, p] of ['a', 'b'].entries()) {
      for (const m of ['zeta', 'alpha']) {
        db.recordEvalResult({
          runId: run.id,
          promptIndex: i,
          prompt: p,
          model: m,
          content: '',
          error: null,
          tokensPerSecond: null,
          durationMs: null,
        });
      }
    }
    expect(db.listEvalResults(run.id).map((r) => `${r.promptIndex}:${r.model}`)).toEqual([
      '0:alpha',
      '0:zeta',
      '1:alpha',
      '1:zeta',
    ]);
  });
});
