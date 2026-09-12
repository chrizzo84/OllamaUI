import { describe, it, expect } from 'vitest';
import {
  parseWikiLinks,
  slugifyEntity,
  stripWikiLinks,
  normalizeClaim,
  estimateTokens,
} from './memory-links';

describe('slugifyEntity', () => {
  // Spelling variants must land on the same node, or the graph grows one
  // duplicate entity per way of typing the same name.
  it('folds spelling variants onto one id', () => {
    for (const variant of ['Ollama Host', 'ollama-host', 'Ollama  HOST', 'ollama_host']) {
      expect(slugifyEntity(variant), variant).toBe('ollama-host');
    }
  });

  it('folds German diacritics and ß', () => {
    expect(slugifyEntity('Größe')).toBe('grosse');
    expect(slugifyEntity('Grosse')).toBe('grosse');
    expect(slugifyEntity('Übersicht')).toBe('ubersicht');
  });

  it('returns nothing for a label with no letters or digits', () => {
    expect(slugifyEntity('!!!')).toBe('');
    expect(slugifyEntity('   ')).toBe('');
  });
});

describe('parseWikiLinks', () => {
  it('extracts every entity in the order written', () => {
    const links = parseWikiLinks('Ollama läuft auf [[Ollama Host]] und einer [[Grafikkarte]].');
    expect(links).toEqual([
      { slug: 'ollama-host', label: 'Ollama Host' },
      { slug: 'grafikkarte', label: 'Grafikkarte' },
    ]);
  });

  it('de-duplicates repeated links', () => {
    expect(parseWikiLinks('[[Homeserver]] und nochmal [[homeserver]]')).toHaveLength(1);
  });

  it('supports [[target|label]] so the sentence can read naturally', () => {
    expect(parseWikiLinks('läuft auf [[ollama-host|dem Server im Keller]]')).toEqual([
      { slug: 'ollama-host', label: 'dem Server im Keller' },
    ]);
  });

  it('ignores empty and unnameable links rather than creating a blank node', () => {
    expect(parseWikiLinks('[[]] [[!!]] text')).toEqual([]);
  });

  it('finds nothing in plain prose', () => {
    expect(parseWikiLinks('ganz normaler Satz')).toEqual([]);
  });
});

describe('stripWikiLinks', () => {
  it('shows the label, not the storage syntax', () => {
    expect(stripWikiLinks('läuft auf [[Ollama Host]]')).toBe('läuft auf Ollama Host');
    expect(stripWikiLinks('läuft auf [[ollama-host|dem Server]]')).toBe('läuft auf dem Server');
  });
});

describe('normalizeClaim', () => {
  // The duplicate check rests on this: the same statement, written twice in
  // two conversations, must compare equal or it accumulates in the prompt.
  it('treats the same claim written differently as equal', () => {
    expect(normalizeClaim('Läuft auf [[Homeserver]].')).toBe(
      normalizeClaim('läuft auf Homeserver'),
    );
    expect(normalizeClaim('Mag  kurze   Antworten!')).toBe(normalizeClaim('mag kurze Antworten'));
  });

  it('keeps genuinely different claims apart', () => {
    expect(normalizeClaim('läuft auf Homeserver')).not.toBe(normalizeClaim('läuft auf dem NUC'));
  });
});

describe('estimateTokens', () => {
  it('grows with length and never returns zero for real text', () => {
    expect(estimateTokens('x')).toBeGreaterThan(0);
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});
