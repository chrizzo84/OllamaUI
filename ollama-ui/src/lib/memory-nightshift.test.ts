import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
The night shift edits the memory while nobody is watching, which makes its
guard rails the part most worth pinning down: what it is allowed to archive,
what it must leave alone, and when it considers itself due.
*/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-ui-nightshift-test-'));
process.env.OLLAMA_UI_DATA_DIR = tmpDir;

const db = await import('./db');
const ns = await import('./memory-nightshift');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  for (const m of db.listMemories()) db.deleteMemory(m.id);
});

/** Writes a fact and backdates it, since decay is about age. */
function aged(
  content: string,
  type: 'identity' | 'state' | 'preference' | 'episodic',
  days: number,
  options: { pinned?: boolean; used?: boolean } = {},
) {
  const r = db.remember({ content, type, subject: null, pinned: options.pinned });
  const at = Date.now() - days * DAY;
  db.dbInstance()
    .prepare('UPDATE memories SET created_at = ?, valid_from = ? WHERE id = ?')
    .run(at, at, r.memory.id);
  if (options.used) db.markMemoriesUsed([r.memory.id]);
  return r.memory.id;
}

describe('what may age out', () => {
  /**
   * Episodic facts are tied to a moment by definition — "war im Mai auf der
   * FOSDEM" stays true forever and stops being interesting — so letting one
   * nobody ever reached for age out is honest.
   */
  it('archives an old episodic fact retrieval never used', () => {
    const id = aged('war vor langer Zeit auf einer Konferenz', 'episodic', 200);
    const stale = db.listDecayableMemories(120 * DAY);
    expect(stale.map((m) => m.id)).toContain(id);
  });

  /**
   * The rule that keeps this from quietly changing how the assistant
   * behaves: a preference nobody happened to ask about this quarter has not
   * stopped being true.
   */
  it('never touches identity, preferences or state, however old', () => {
    const identity = aged('heißt Alex', 'identity', 900);
    const preference = aged('mag kurze Antworten', 'preference', 900);
    const state = aged('arbeitet an einem Projekt', 'state', 900);
    const stale = db.listDecayableMemories(120 * DAY).map((m) => m.id);
    expect(stale).not.toContain(identity);
    expect(stale).not.toContain(preference);
    expect(stale).not.toContain(state);
  });

  it('never touches a pinned fact', () => {
    const id = aged('altes Ereignis, aber angepinnt', 'episodic', 900, { pinned: true });
    expect(db.listDecayableMemories(120 * DAY).map((m) => m.id)).not.toContain(id);
  });

  // Having been retrieved even once is evidence someone's questions touch on
  // it, whatever its age.
  it('never touches a fact retrieval has used', () => {
    const id = aged('altes Ereignis, aber schon mal gebraucht', 'episodic', 900, { used: true });
    expect(db.listDecayableMemories(120 * DAY).map((m) => m.id)).not.toContain(id);
  });

  it('leaves a recent episodic fact alone', () => {
    const id = aged('war letzte Woche unterwegs', 'episodic', 3);
    expect(db.listDecayableMemories(120 * DAY).map((m) => m.id)).not.toContain(id);
  });

  it('archives rather than deletes, so the history survives', () => {
    const id = aged('war vor langer Zeit auf einer Konferenz', 'episodic', 200);
    db.archiveMemory(id);
    expect(db.getMemory(id)?.status).toBe('archived');
    expect(db.listTimeline().some((e) => e.memoryId === id)).toBe(true);
  });
});

describe('what is worth merging', () => {
  /**
   * Only the band the write path deliberately stays out of: above the
   * displacement threshold it has already resolved it, below the floor the
   * two facts are simply different.
   */
  it('offers the overlapping pair and not the unrelated one', () => {
    db.remember({
      content: 'Der Nutzer hat einen Mini-PC mit 32 GB RAM.',
      subject: 'hardware',
    });
    db.remember({
      content: 'Der Nutzer nutzt den Mini-PC mit 32 GB RAM für lokale KI und Docker.',
      subject: 'nutzung',
    });
    db.remember({ content: 'Der Nutzer kocht gern Pasta.', subject: 'kochen' });

    const pairs = db.listMergeCandidates();
    expect(pairs.length).toBeGreaterThan(0);
    const contents = pairs.flatMap((p) => [p.a.content, p.b.content]);
    expect(contents.some((c) => c.includes('Pasta'))).toBe(false);
  });

  it('offers nothing when facts have already displaced each other', () => {
    db.remember({ content: 'Der Nutzer wohnt in Musterstadt.', subject: 'wohnort' });
    db.remember({ content: 'Der Nutzer wohnt jetzt in Musterstadt.', subject: 'wohnort' });
    // The second displaced the first, so only one is active and there is no pair.
    expect(db.listMergeCandidates()).toHaveLength(0);
  });
});

describe('when it runs', () => {
  beforeEach(() => {
    db.dbInstance().prepare('DELETE FROM memory_maintenance_runs').run();
  });

  const settings = { ...ns.DEFAULT_NIGHT_SHIFT, enabled: true, timeOfDay: '03:30' };

  it('is not due before its time', () => {
    const morning = new Date();
    morning.setHours(2, 0, 0, 0);
    expect(ns.isNightShiftDue(morning, settings)).toBe(false);
  });

  it('is due once the time has passed and nothing ran since', () => {
    const later = new Date();
    later.setHours(4, 0, 0, 0);
    expect(ns.isNightShiftDue(later, settings)).toBe(true);
  });

  // One run per slot, whatever its outcome — a failed pass must not retry
  // every minute for the rest of the day.
  it('is not due again after a run started in the same slot', () => {
    const later = new Date();
    later.setHours(4, 0, 0, 0);
    db.startMaintenanceRun('schedule', 'irgendein-modell');
    expect(ns.isNightShiftDue(later, settings)).toBe(false);
  });

  it('is never due while switched off', () => {
    const later = new Date();
    later.setHours(4, 0, 0, 0);
    expect(ns.isNightShiftDue(later, { ...settings, enabled: false })).toBe(false);
  });
});

describe('the record it leaves', () => {
  it('counts what a run touched', () => {
    const id = db.startMaintenanceRun('manual', 'modell');
    db.updateMaintenanceRun(id, { conversationsRead: 3, factsFound: 5, archived: 2 });
    db.updateMaintenanceRun(id, { status: 'done', finished: true });
    const [run] = db.listMaintenanceRuns(1);
    expect(run).toMatchObject({
      status: 'done',
      conversationsRead: 3,
      factsFound: 5,
      archived: 2,
      trigger: 'manual',
    });
    expect(run.finishedAt).toBeGreaterThan(0);
  });

  it('keeps the reason a run failed', () => {
    const id = db.startMaintenanceRun('schedule', null);
    db.updateMaintenanceRun(id, { status: 'error', error: 'host unreachable', finished: true });
    expect(db.listMaintenanceRuns(1)[0].error).toBe('host unreachable');
  });
});
