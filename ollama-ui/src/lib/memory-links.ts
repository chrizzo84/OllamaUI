/**
 * The [[Wikilink]] layer of the knowledge base.
 *
 * A memory stays what it always was — one readable sentence — and the graph
 * is derived from it rather than maintained beside it: "Ollama runs on
 * [[Ollama Host]] with a [[Grafikkarte]]" is a fact a person can read and two
 * edges a graph can draw. Nothing has to be kept in sync, because there is
 * only one copy of the information.
 *
 * This syntax is also the one thing here chosen for the *writer* rather than
 * the reader: language models produce `[[...]]` reliably and almost never
 * mangle it, which matters when the author of every fact is a model.
 *
 * Pure string work — no database, no I/O — so the parsing rules can be
 * tested directly.
 */

export interface WikiLink {
  /** Stable node id: lower-case, punctuation folded to dashes. */
  slug: string;
  /** How it was written the first time, for display. */
  label: string;
}

/**
 * `[[Label]]` and `[[slug|Label]]` — the second form only matters when two
 * different spellings must point at the same node and the sentence needs the
 * other spelling to read naturally.
 */
const LINK_PATTERN = /\[\[([^\]|]{1,120})(?:\|([^\]]{1,120}))?\]\]/g;

/**
 * Folds a label to a node id. Diacritics are stripped so "Größe" and
 * "Grosse" don't become two nodes; everything that isn't a letter or digit
 * becomes a single dash, so spelling variants ("Ollama-Host", "ollama host")
 * land on the same entity.
 */
export function slugifyEntity(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Every entity a memory refers to, de-duplicated, in the order written. A
 * link whose label folds to nothing (`[[...]]`, `[[!!]]`) is dropped rather
 * than creating an unnamed node.
 */
export function parseWikiLinks(text: string): WikiLink[] {
  const seen = new Map<string, WikiLink>();
  for (const match of text.matchAll(LINK_PATTERN)) {
    const target = match[1].trim();
    const label = (match[2] ?? match[1]).trim();
    const slug = slugifyEntity(target);
    if (!slug || seen.has(slug)) continue;
    seen.set(slug, { slug, label });
  }
  return [...seen.values()];
}

/**
 * The fact as a reader (or a model) should see it: `[[Ollama Host]]` becomes
 * "Ollama Host". Used for the prompt — the brackets are storage syntax, and
 * putting them in front of the model only invites it to imitate them in its
 * prose.
 */
export function stripWikiLinks(text: string): string {
  return text.replace(LINK_PATTERN, (_m, target: string, label?: string) =>
    (label ?? target).trim(),
  );
}

/**
 * A rough token count, for the retrieval budget. Deliberately an estimate:
 * the real tokenizer lives in whatever model is loaded, and asking it would
 * mean a round trip per fact per prompt. ~4 characters per token is close
 * enough for German and English prose, and the budget is a guard rail, not
 * an accounting system.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Normalized form for comparing two facts: link syntax removed, whitespace
 * collapsed, case and trailing punctuation folded away. "Läuft auf
 * [[Homeserver]]." and "läuft auf Homeserver" are the same claim written twice, and
 * storing both means the model reads the same thing twice in every prompt.
 */
export function normalizeClaim(text: string): string {
  return stripWikiLinks(text)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
