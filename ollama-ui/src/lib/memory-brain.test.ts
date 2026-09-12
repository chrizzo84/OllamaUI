import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
Against a real SQLite file, for the same reason db.test.ts is: displacement,
the FTS ranking and the edge queries are behaviours of the database, not of
code that could be meaningfully faked. Own directory and own module instance,
since db.ts reads OLLAMA_UI_DATA_DIR once at import.
*/
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ollama-ui-brain-test-'));
process.env.OLLAMA_UI_DATA_DIR = tmpDir;

const db = await import('./db');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

beforeEach(() => {
  for (const m of db.listMemories()) db.deleteMemory(m.id);
});

describe('remember: displacement', () => {
  /**
   * The failure this whole design exists for: two answers to the same
   * question, both stored as true, and the model picking one at random.
   */
  it('a new fact about the same subject supersedes the old one', () => {
    const first = db.remember({ content: 'Ollama läuft auf dem [[Ollama Host]] im Keller' });
    const second = db.remember({ content: '[[Ollama Host]] ist jetzt 192.0.2.10' });

    expect(second.superseded?.id).toBe(first.memory.id);
    expect(db.getMemory(first.memory.id)?.status).toBe('superseded');
    expect(db.getMemory(first.memory.id)?.supersededBy).toBe(second.memory.id);
    expect(db.getMemory(second.memory.id)?.status).toBe('active');
  });

  it('keeps the displaced fact as history rather than deleting it', () => {
    db.remember({ content: '[[Ollama Host]] läuft auf dem NUC' });
    db.remember({ content: '[[Ollama Host]] läuft auf dem großen Server' });
    const history = db.listMemoryHistory('ollama-host');
    expect(history).toHaveLength(2);
    expect(history[0].validUntil).not.toBeNull(); // stopped being true
    expect(history[1].validUntil).toBeNull(); // still true
  });

  it('leaves facts about other subjects alone', () => {
    db.remember({ content: '[[Ollama Host]] hat zwei GPUs' });
    db.remember({ content: '[[Homeserver]] läuft auf derselben Kiste' });
    expect(db.listMemories({ status: 'active' })).toHaveLength(2);
  });

  it('derives the subject from the first link when none is given', () => {
    const r = db.remember({ content: 'Auf [[Homeserver]] läuft auch [[Plex]]' });
    expect(r.memory.subject).toBe('homeserver');
  });

  it('accepts an explicit subject, slugified', () => {
    const r = db.remember({ content: 'mag kurze Antworten', subject: 'Antwort Stil' });
    expect(r.memory.subject).toBe('antwort-stil');
  });

  // A fact about nothing in particular ("war letzte Woche in Berlin") must
  // not displace anything — episodic facts accumulate by design.
  it('a fact without a subject displaces nothing', () => {
    db.remember({ content: 'war im Mai in Berlin', subject: null, type: 'episodic' });
    db.remember({ content: 'war im Juni in Hamburg', subject: null, type: 'episodic' });
    expect(db.listMemories({ status: 'active' })).toHaveLength(2);
  });
});

describe('remember: duplicates and contradictions', () => {
  it('stores the same claim only once, however it is worded', () => {
    const first = db.remember({ content: 'Läuft auf [[Homeserver]].' });
    const again = db.remember({ content: 'läuft auf Homeserver', subject: 'homeserver' });
    expect(again.duplicate).toBe(true);
    expect(again.memory.id).toBe(first.memory.id);
    expect(db.listMemories()).toHaveLength(1);
  });

  it('records a contradiction when the claim actually changed', () => {
    db.remember({ content: '[[Ollama Host]] läuft auf dem NUC' });
    const second = db.remember({ content: '[[Ollama Host]] läuft auf dem großen Server' });
    expect(second.contradicted).toBe(true);

    const open = db.listContradictions();
    expect(open).toHaveLength(1);
    expect(open[0].newer?.content).toContain('großen Server');
    expect(open[0].older?.content).toContain('NUC');
  });

  it('a contradiction can be settled, and then leaves the queue', () => {
    db.remember({ content: '[[Ollama Host]] läuft auf dem NUC' });
    db.remember({ content: '[[Ollama Host]] läuft auf dem großen Server' });
    const [open] = db.listContradictions();
    db.resolveEdge(open.edge.id);
    expect(db.listContradictions()).toHaveLength(0);
  });
});

describe('resolving a contradiction', () => {
  function conflict() {
    const older = db.remember({ content: '[[Ollama Host]] läuft auf dem NUC' });
    const newer = db.remember({ content: '[[Ollama Host]] läuft auf dem großen Server' });
    return { older: older.memory, newer: newer.memory, edge: db.listContradictions()[0].edge };
  }

  it('keeping the newer one just settles it', () => {
    const { older, newer, edge } = conflict();
    db.resolveContradiction(edge.id, 'newer');
    expect(db.getMemory(newer.id)?.status).toBe('active');
    expect(db.getMemory(older.id)?.status).toBe('superseded');
    expect(db.listContradictions()).toHaveLength(0);
  });

  /**
   * The correction path: the replacement was simply wrong. The two swap
   * roles rather than the bad write being deleted, so the record that the
   * mistake happened survives.
   */
  it('keeping the older one swaps the roles', () => {
    const { older, newer, edge } = conflict();
    db.resolveContradiction(edge.id, 'older');
    expect(db.getMemory(older.id)?.status).toBe('active');
    expect(db.getMemory(older.id)?.supersededBy).toBeNull();
    expect(db.getMemory(newer.id)?.status).toBe('superseded');
    expect(db.getMemory(newer.id)?.supersededBy).toBe(older.id);
    expect(db.recallMemories({ query: 'Ollama Host NUC' }).map((m) => m.id)).toContain(older.id);
  });

  it('re-points the history so it reads as what actually happened', () => {
    const { older, newer, edge } = conflict();
    db.resolveContradiction(edge.id, 'older');
    const supersedes = db.listEdgesForMemory(older.id).filter((e) => e.kind === 'supersedes');
    expect(supersedes.some((e) => e.fromId === older.id && e.toId === newer.id)).toBe(true);
    expect(supersedes.some((e) => e.fromId === newer.id && e.toId === older.id)).toBe(false);
  });

  /**
   * "They were never the same question": both stay, but the older one loses
   * its subject so it stops competing for the single active slot — otherwise
   * the next write would silently displace only one of the two.
   */
  it('keeping both takes the older one out of the competition', () => {
    const { older, newer, edge } = conflict();
    db.resolveContradiction(edge.id, 'both');
    expect(db.getMemory(older.id)?.status).toBe('active');
    expect(db.getMemory(older.id)?.subject).toBeNull();
    expect(db.getMemory(newer.id)?.status).toBe('active');

    // A third fact on the subject must now displace only the newer one.
    db.remember({ content: '[[Ollama Host]] ist jetzt ein Mac Mini' });
    expect(db.getMemory(older.id)?.status).toBe('active');
    expect(db.getMemory(newer.id)?.status).toBe('superseded');
  });

  it('ignores an edge that is not a contradiction', () => {
    const { older, newer } = conflict();
    const supersedes = db.listEdgesForMemory(newer.id).find((e) => e.kind === 'supersedes');
    db.resolveContradiction(supersedes!.id, 'older');
    expect(db.getMemory(older.id)?.status).toBe('superseded');
  });
});

describe('re-classifying by hand', () => {
  it('sets the type a person knows better than the model does', () => {
    const r = db.remember({ content: 'heißt [[Alex]]' });
    db.updateMemoryClassification(r.memory.id, { type: 'identity' });
    expect(db.getMemory(r.memory.id)?.type).toBe('identity');
    expect(db.recallMemories({ query: 'irgendwas anderes' }).map((m) => m.id)).toContain(
      r.memory.id,
    );
  });

  it('giving a fact a subject makes it take part in displacement', () => {
    const loose = db.remember({ content: 'nutzt gerne Docker', subject: null });
    db.updateMemoryClassification(loose.memory.id, { subject: 'Container Setup' });
    expect(db.getMemory(loose.memory.id)?.subject).toBe('container-setup');
    db.remember({ content: 'nutzt jetzt Podman', subject: 'container-setup' });
    expect(db.getMemory(loose.memory.id)?.status).toBe('superseded');
  });
});

describe('remember: the write gate', () => {
  it('parks a low-confidence fact as a draft, out of every prompt', () => {
    const r = db.remember({ content: 'heißt vielleicht [[Chris]]', confidence: 0.3 });
    expect(r.memory.status).toBe('draft');
    expect(db.recallMemories({ query: 'Chris' }).map((m) => m.id)).not.toContain(r.memory.id);
  });

  it('a draft displaces nothing until it is approved', () => {
    const sure = db.remember({ content: '[[Ollama Host]] ist 192.0.2.10' });
    db.remember({ content: '[[Ollama Host]] ist vielleicht was anderes', confidence: 0.2 });
    expect(db.getMemory(sure.memory.id)?.status).toBe('active');
  });

  it('approving a draft makes it retrievable', () => {
    const r = db.remember({ content: 'mag [[Kaffee]]', confidence: 0.3 });
    db.approveMemory(r.memory.id);
    expect(db.getMemory(r.memory.id)?.status).toBe('active');
  });
});

describe('the graph', () => {
  it('creates an entity per link and an about edge to it', () => {
    const r = db.remember({ content: 'Auf [[Homeserver]] läuft [[Plex]]' });
    expect(
      db
        .listEntities()
        .map((e) => e.id)
        .sort(),
    ).toEqual(['plex', 'homeserver']);
    const about = db.listEdgesForMemory(r.memory.id).filter((e) => e.kind === 'about');
    expect(about.map((e) => e.toId).sort()).toEqual(['plex', 'homeserver']);
  });

  it('answers what is known about one entity — the backlink view', () => {
    db.remember({ content: '[[Homeserver]] läuft auf der großen Kiste' });
    db.remember({ content: 'Backups liegen auf [[Homeserver]]', subject: 'backups' });
    const about = db.listMemoriesForEntity('homeserver');
    expect(about).toHaveLength(2);
  });

  /**
   * A superseded fact listed beside the one that replaced it reads as two
   * competing truths — exactly the impression the whole design removes.
   * Caught in the browser: the graph's detail panel showed "Server is a NUC"
   * next to "Server is a big box", both looking current.
   */
  it('leaves replaced facts out of the backlinks unless asked for', () => {
    db.remember({ content: '[[Server]] ist ein NUC', subject: 'server-hw' });
    db.remember({ content: '[[Server]] ist eine große Kiste', subject: 'server-hw' });
    const current = db.listMemoriesForEntity('server');
    expect(current).toHaveLength(1);
    expect(current[0].content).toContain('große Kiste');
    expect(db.listMemoriesForEntity('server', { includeHistory: true })).toHaveLength(2);
  });

  it('links a fact back to the conversation it came from', () => {
    const session = db.createSession({});
    const r = db.remember({ content: 'mag [[Tee]]', sourceSessionId: session.id });
    const edges = db.listEdgesForMemory(r.memory.id);
    expect(edges.some((e) => e.kind === 'derived_from' && e.toId === session.id)).toBe(true);
  });

  it('deleting a memory takes its edges with it', () => {
    const r = db.remember({ content: 'etwas über [[Docker]]' });
    db.deleteMemory(r.memory.id);
    expect(db.listEdgesForMemory(r.memory.id)).toHaveLength(0);
  });

  // An entity exists only as the target of a link; once nothing mentions it,
  // leaving it behind means the graph slowly fills with unconnected dots.
  it('removes an entity once nothing points at it any more', () => {
    const r = db.remember({ content: 'etwas über [[Kubernetes]]' });
    expect(db.listEntities().map((e) => e.id)).toContain('kubernetes');
    db.deleteMemory(r.memory.id);
    expect(db.listEntities().map((e) => e.id)).not.toContain('kubernetes');
  });

  it('keeps an entity that superseded history still mentions', () => {
    db.remember({ content: '[[Ollama Host]] ist der NUC' });
    db.remember({ content: '[[Ollama Host]] ist der große Server' });
    const [oldest] = db.listMemoryHistory('ollama-host');
    expect(oldest.status).toBe('superseded');
    expect(db.listEntities().map((e) => e.id)).toContain('ollama-host');
  });
});

describe('the graph view', () => {
  it('returns facts and entities as nodes, with the edges between them', () => {
    db.remember({ content: 'Auf [[Homeserver]] läuft [[Plex]]' });
    const g = db.buildGraph();
    expect(
      g.nodes
        .filter((n) => n.kind === 'entity')
        .map((n) => n.label)
        .sort(),
    ).toEqual(['Plex', 'Homeserver']);
    expect(g.edges.filter((e) => e.kind === 'about')).toHaveLength(2);
  });

  // A session is not a node in this picture; drawing one per fact would
  // double the node count with nothing to learn from it.
  it('leaves derived_from edges out', () => {
    const session = db.createSession({});
    db.remember({ content: 'etwas über [[Docker]]', sourceSessionId: session.id });
    expect(db.buildGraph().edges.some((e) => e.kind === 'derived_from')).toBe(false);
  });

  it('hides history unless asked for it', () => {
    db.remember({ content: '[[Host]] ist A' });
    db.remember({ content: '[[Host]] ist B' });
    expect(db.buildGraph().nodes.filter((n) => n.kind === 'memory')).toHaveLength(1);
    const withHistory = db.buildGraph({ includeHistory: true });
    expect(withHistory.nodes.filter((n) => n.kind === 'memory')).toHaveLength(2);
    expect(withHistory.edges.some((e) => e.kind === 'supersedes')).toBe(true);
  });

  // An edge whose other end was filtered out would render as a line into
  // nowhere.
  it('never returns an edge with a missing endpoint', () => {
    db.remember({ content: '[[Host]] ist A' });
    db.remember({ content: '[[Host]] ist B' });
    const g = db.buildGraph();
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source), e.kind).toBe(true);
      expect(ids.has(e.target), e.kind).toBe(true);
    }
  });

  it('walks only the neighbourhood around a focus', () => {
    db.remember({ content: 'Auf [[Homeserver]] läuft [[Plex]]' });
    db.remember({ content: 'weit weg von allem [[Anderes]]', subject: 'anderes' });
    const g = db.buildGraph({ focus: 'entity:plex', hops: 1 });
    const labels = g.nodes.map((n) => n.label);
    expect(labels).toContain('Plex');
    expect(labels.some((l) => l.includes('Homeserver läuft'))).toBe(true);
    expect(labels).not.toContain('Anderes');
  });

  it('accepts a focus with no edges at all', () => {
    const lonely = db.remember({ content: 'ganz ohne Verlinkung', subject: 'einsam' });
    const g = db.buildGraph({ focus: `memory:${lonely.memory.id}` });
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(0);
  });

  // A hairball is not a view: without a focus the cap keeps what the graph is
  // actually about rather than whatever was written last.
  it('caps the overview and says how much it left out', () => {
    for (let i = 0; i < 60; i++) {
      db.remember({ content: `Fakt ${i} über [[Ding${i}]]`, subject: `ding-${i}` });
    }
    const g = db.buildGraph({ limit: 20 });
    expect(g.nodes.length).toBeLessThanOrEqual(20);
    expect(g.truncated).toBeGreaterThan(0);
  });

  it('counts what is known per entity', () => {
    db.remember({ content: '[[Homeserver]] läuft auf der großen Kiste' });
    db.remember({ content: 'Backups liegen auf [[Homeserver]]', subject: 'backups' });
    db.remember({ content: 'etwas über [[Plex]]', subject: 'plex-info' });
    const counts = db.listEntitiesWithCounts();
    expect(counts[0].id).toBe('homeserver');
    expect(counts[0].memoryCount).toBe(2);
  });
});

describe('recall', () => {
  it('always includes identity facts, however old they are', () => {
    const identity = db.remember({ content: 'heißt [[Alex]]', type: 'identity' });
    for (let i = 0; i < 60; i++) db.remember({ content: `irgendein Fakt Nummer ${i}` });
    const recalled = db.recallMemories({ query: 'Docker' });
    expect(recalled.map((m) => m.id)).toContain(identity.memory.id);
  });

  it('always includes pinned facts', () => {
    const pinned = db.remember({ content: 'antworte immer auf Deutsch', pinned: true });
    for (let i = 0; i < 40; i++) db.remember({ content: `Fakt ${i} über etwas anderes` });
    expect(db.recallMemories({ query: 'GPU' }).map((m) => m.id)).toContain(pinned.memory.id);
  });

  it('prefers facts relevant to the conversation', () => {
    db.remember({ content: 'mag Pizza mit Ananas', subject: 'pizza' });
    const gpu = db.remember({ content: 'hat zwei [[RTX 3090]] im Rechner' });
    const recalled = db.recallMemories({ query: 'Wie viel VRAM hat meine RTX 3090?', limit: 2 });
    expect(recalled.map((m) => m.id)).toContain(gpu.memory.id);
  });

  // The point of the budget: a fact costs context, and on a small local model
  // fifty of them are a tenth of the window spent on nothing in particular.
  it('respects the token budget instead of a row count', () => {
    for (let i = 0; i < 80; i++) {
      db.remember({ content: `Fakt ${i}: ${'x'.repeat(200)}`, subject: `fakt-${i}` });
    }
    const recalled = db.recallMemories({ query: 'Fakt', tokenBudget: 200 });
    const spent = recalled.reduce((sum, m) => sum + Math.ceil(m.content.length / 4), 0);
    expect(spent).toBeLessThanOrEqual(200);
    expect(recalled.length).toBeGreaterThan(0);
  });

  it('never returns superseded or archived facts', () => {
    const first = db.remember({ content: '[[Host]] ist A' });
    db.remember({ content: '[[Host]] ist B' });
    const archived = db.remember({ content: 'etwas Altes', subject: 'altes' });
    db.archiveMemory(archived.memory.id);
    const ids = db.recallMemories({ query: 'Host altes' }).map((m) => m.id);
    expect(ids).not.toContain(first.memory.id);
    expect(ids).not.toContain(archived.memory.id);
  });

  /**
   * German inflects at the end of the word, so a question asked as "Was
   * koche ich?" and a fact stored as "kocht gern Pasta" share no whole word.
   * Without prefix matching this silently returns nothing and looks exactly
   * like the memory was never saved — measured on a 48-fact store, where it
   * returned five unrelated facts and not the relevant one.
   */
  it('matches an inflected German verb against the stored form', () => {
    const pasta = db.remember({ content: 'kocht gern [[Pasta]] mit Salbeibutter' });
    db.remember({ content: 'fährt ein [[Rennrad]]', subject: 'rennrad' });
    const ids = db.recallMemories({ query: 'Was koche ich heute Abend?' }).map((m) => m.id);
    expect(ids).toContain(pasta.memory.id);
  });

  // "Wie viel VRAM…" used to pull in "hört viel Techno" — a match on a word
  // that carries no meaning, costing a slot in an already tight budget.
  it('ignores words that appear in every sentence', () => {
    const music = db.remember({ content: 'hört viel [[Techno]]', subject: 'musik' });
    const gpu = db.remember({ content: 'hat zwei [[RTX 3090]]', subject: 'gpus' });
    const ids = db.recallMemories({ query: 'Wie viel VRAM hat meine 3090?' }).map((m) => m.id);
    expect(ids).toContain(gpu.memory.id);
    expect(ids).not.toContain(music.memory.id);
  });

  /**
   * Leftover budget must stay unspent rather than be filled with whatever is
   * newest: that is the original bug in a new place, and because the newest
   * facts tend to be the most trivial, it crowds out the ones that matter.
   */
  it('does not pad the budget with irrelevant facts', () => {
    const gpu = db.remember({ content: 'hat zwei [[RTX 3090]]', subject: 'gpus' });
    for (let i = 0; i < 30; i++) {
      db.remember({ content: `Nebensache ${i} ohne Bezug`, subject: `neben-${i}` });
    }
    const recalled = db.recallMemories({ query: 'Wie viel VRAM hat meine 3090?' });
    expect(recalled.map((m) => m.id)).toContain(gpu.memory.id);
    expect(recalled.length).toBeLessThan(5);
  });

  // A first message with nothing to match on should still carry something.
  it('falls back to a few recent facts when nothing matches', () => {
    for (let i = 0; i < 30; i++) db.remember({ content: `Fakt ${i}`, subject: `f-${i}` });
    const recalled = db.recallMemories({ query: 'Hi!' });
    expect(recalled.length).toBeGreaterThan(0);
    expect(recalled.length).toBeLessThanOrEqual(6);
  });

  it('works with no query at all', () => {
    db.remember({ content: 'irgendwas' });
    expect(db.recallMemories()).toHaveLength(1);
  });

  it('survives a query full of FTS syntax', () => {
    db.remember({ content: 'mag [[Kaffee]]' });
    expect(() => db.recallMemories({ query: 'was ist "das" AND (oder) * NEAR/2' })).not.toThrow();
  });
});

describe('usage tracking', () => {
  it('counts what retrieval actually used', () => {
    const r = db.remember({ content: 'mag [[Kaffee]]' });
    db.markMemoriesUsed([r.memory.id]);
    db.markMemoriesUsed([r.memory.id]);
    const after = db.getMemory(r.memory.id);
    expect(after?.useCount).toBe(2);
    expect(after?.lastUsedAt).toBeGreaterThan(0);
  });
});

describe('buildMemoryBlock', () => {
  it('groups by role and drops the link syntax', () => {
    const block = db.buildMemoryBlock([
      db.remember({ content: 'heißt [[Alex]]', type: 'identity' }).memory,
      db.remember({ content: 'mag kurze Antworten', type: 'preference', subject: 'stil' }).memory,
    ]);
    expect(block).toContain('About this user');
    expect(block).toContain('heißt Alex');
    expect(block).not.toContain('[[');
    expect(block).toContain('How they want you to work');
  });

  it('is empty when there is nothing to say', () => {
    expect(db.buildMemoryBlock([])).toBe('');
  });
});

describe('backwards compatibility', () => {
  // The existing remember_fact tool calls createMemory and must keep working
  // unchanged while the typed path is wired up.
  it('createMemory still stores a fact', () => {
    const m = db.createMemory({ content: 'alter Aufrufpfad' });
    expect(db.getMemory(m.id)?.content).toBe('alter Aufrufpfad');
    expect(db.getMemory(m.id)?.type).toBe('unsorted');
    expect(db.getMemory(m.id)?.status).toBe('active');
  });
});
