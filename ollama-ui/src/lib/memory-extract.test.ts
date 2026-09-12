import { describe, it, expect } from 'vitest';
import { looksWorthExtracting, alreadySavedDuringReply } from './memory-extract';
import type { TraceEvent } from '@/store/chat';

describe('looksWorthExtracting', () => {
  // The gate exists so a 35B model isn't woken for every "danke". It is
  // deliberately lopsided: a false positive costs one background call, a
  // false negative loses the fact for good.
  it('catches first-person statements in German', () => {
    for (const text of [
      'Meine Kiste ist ein Mini-PC mit 32 GB RAM und einer Grafikkarte',
      'Ich nutze Homeserver als Server-OS',
      'Bei mir läuft Ollama auf einem eigenen Rechner',
      'Mein Name ist übrigens Alex, bin 30 Jahre alt',
      'Bitte antworte mir immer kurz und ohne Vorrede',
    ]) {
      expect(looksWorthExtracting(text), text).toBe(true);
    }
  });

  it('catches them in English too', () => {
    for (const text of [
      "I'm running this on a machine with 128GB of RAM",
      'My main model is gpt-oss and I use it daily',
      'We have a second server in the basement',
    ]) {
      expect(looksWorthExtracting(text), text).toBe(true);
    }
  });

  it('ignores questions and chatter that state nothing about the user', () => {
    for (const text of [
      'Kannst du mir kurz erklären wie ein Transformer funktioniert?',
      'Was ist der Unterschied zwischen Q4 und Q8?',
      'danke!',
      'ja',
      'Guten Morgen!',
      'Schreib mir bitte eine Funktion, die zwei Zahlen addiert.',
    ]) {
      expect(looksWorthExtracting(text), text).toBe(false);
    }
  });

  // "mir"/"mich" carry a fact in a statement and none in a request; the
  // sentence shape is what separates them, not the pronoun.
  /**
   * All three contain "mir" and only the first states something durable.
   * Grammar doesn't separate them — the first two are both imperatives — so
   * a weak pronoun needs a word claiming the instruction outlives the
   * message. Without this, every "schreib mir eine Funktion" in a coding
   * session would wake the extractor and occupy the GPU.
   */
  it('counts a bare "mir" only alongside a standing-rule word', () => {
    expect(looksWorthExtracting('Bitte antworte mir immer kurz und ohne Vorrede')).toBe(true);
    expect(looksWorthExtracting('Schreib mir bitte eine Funktion, die zwei Zahlen addiert.')).toBe(
      false,
    );
    expect(looksWorthExtracting('Kannst du mir das mal genauer aufschreiben?')).toBe(false);
  });

  it('ignores anything too short to hold a fact', () => {
    expect(looksWorthExtracting('ich auch')).toBe(false);
    expect(looksWorthExtracting('')).toBe(false);
  });
});

describe('looksWorthExtracting: answers to a question', () => {
  const question = 'Ich muss ehrlich sein: ich weiß nicht, wo du wohnst. Wo denn?';

  /**
   * The case this was missing entirely. Asked where he lives, the reply was
   * "Musterstadt!" — no "ich", no "mein", because the
   * subject sits in the question rather than the answer. The gate rejected
   * it, the extraction never ran, and the fact was only stored two messages
   * later when the user asked whether it had been.
   */
  it('lets through a short answer that carries no first-person marker', () => {
    expect(looksWorthExtracting('Musterstadt!', question)).toBe(true);
    expect(looksWorthExtracting('Musterstadt!')).toBe(false);
  });

  it('lets through an answer far shorter than the normal minimum', () => {
    expect(looksWorthExtracting('Kassel', question)).toBe(true);
  });

  // Otherwise every confirmation in a conversation would wake the extractor.
  it('still ignores a bare acknowledgement', () => {
    for (const reply of ['ja', 'Ja!', 'ok', 'passt', 'danke', 'genau', 'yes', 'nope']) {
      expect(looksWorthExtracting(reply, question), reply).toBe(false);
    }
  });

  it('does not treat a reply that merely mentions "?" early on as a question', () => {
    const notAQuestion = 'Gute Frage? Nein, im Ernst: hier ist die Antwort. ' + 'x'.repeat(250);
    expect(looksWorthExtracting('Musterstadt', notAQuestion)).toBe(false);
  });
});

describe('alreadySavedDuringReply', () => {
  // No point asking again when the model already managed it — the second
  // look exists for the runs where it didn't.
  it('is true when remember_fact was called during the reply', () => {
    const trace: TraceEvent[] = [
      { type: 'thinking', id: '1', text: '…' },
      { type: 'tool', id: '2', name: 'remember_fact', arguments: { fact: 'x' }, result: {} },
    ];
    expect(alreadySavedDuringReply(trace)).toBe(true);
  });

  it('is false when another tool ran, or none did', () => {
    expect(
      alreadySavedDuringReply([
        { type: 'tool', id: '2', name: 'web_search', arguments: {}, result: {} },
      ]),
    ).toBe(false);
    expect(alreadySavedDuringReply([{ type: 'thinking', id: '1', text: '…' }])).toBe(false);
    expect(alreadySavedDuringReply([])).toBe(false);
  });
});
