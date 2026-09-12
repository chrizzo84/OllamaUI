/**
 * The second look: did this message contain something worth remembering that
 * the model forgot to save?
 *
 * Measured against a local 35B model on a plainly durable statement — "meine
 * Kiste ist ein Mini-PC mit 32 GB RAM und einer Grafikkarte" — the `remember_fact`
 * tool fired in 1 of 5 runs with the original tool description and 3 of 5
 * after rewriting it. Better, and still not something to rely on: two in five
 * facts silently never arrive, and the user has no way of knowing which.
 *
 * The reason is structural rather than a bad prompt. During a reply the model
 * is doing two jobs at once — answer the question, and notice in passing that
 * a fact went by — and the first one wins, especially on a small model.
 * Asking the *same* model the single narrow question afterwards, with only
 * this one tool available and nothing else to do, is a much easier task than
 * the one it just failed.
 *
 * Two deliberate constraints:
 *
 *  - **Same model, after the reply.** Reusing the model that is already
 *    loaded costs no model swap, which on a local single-GPU box is the
 *    difference between a background step and a visible stall. And it runs
 *    once the answer is already on screen, so nobody waits for it.
 *  - **Everything it finds is a draft.** These facts were extracted with no
 *    one watching, by a pass whose whole premise is that the model's
 *    judgement was unreliable a moment ago. They land in the review queue on
 *    the Memory page, not in the next prompt. Writing unwatched inferences
 *    straight into long-term memory is the one failure mode that compounds.
 *
 * This mirrors what schedule-verify.ts already does for scheduling claims:
 * check the trace rather than trust the model, and repair afterwards.
 */
import { remember, listMemories, type MemoryType, isMemoryType } from '@/lib/db';
import { stripWikiLinks } from '@/lib/memory-links';
import type { TraceEvent } from '@/store/chat';

/**
 * Cheap gate, so a 35B model isn't woken for "danke" or "erklär mir
 * Transformer". Deliberately lopsided: a false positive costs one background
 * call, a false negative loses the fact for good, which is the failure this
 * file exists to prevent.
 *
 * Matches the grammatical shape of "here is something about me", which is
 * how a durable fact almost always arrives.
 */
export const SELF_STATEMENT_RE =
  /\b(ich|mein|meine|meinem|meinen|meiner|unser|unsere|unserem|bei mir|zuhause|i'm|i am|i've|my|mine|i use|i have|i run|i work|i prefer|i like|i own|we use|we have)\b/i;

/**
 * "mir" and "mich" are too weak on their own. All three of these contain one
 * and only the first carries a durable fact:
 *
 *   "antworte mir immer kurz und ohne Vorrede"   → a standing preference
 *   "schreib mir bitte eine Funktion"            → a task for right now
 *   "kannst du mir das erklären?"                → a request
 *
 * Grammar does not separate them — the first two are both imperatives. What
 * does is a word claiming the instruction holds beyond this message. So a
 * weak pronoun only counts alongside one of those, which keeps the extractor
 * off the GPU during a coding session full of "schreib mir …".
 */
const WEAK_SELF_RE = /\b(mir|mich)\b/i;
const STANDING_RULE_RE =
  /\b(immer|nie|niemals|generell|grundsätzlich|standardmä(ß|ss)ig|in zukunft|ab jetzt|ab sofort|always|never|generally|by default|from now on)\b/i;

/** Below this there is nothing to extract — a "ja" or "passt" carries no fact. */
const MIN_LENGTH = 25;

/**
 * Bare acknowledgements. An answer to a question is let through (see below)
 * and these are the answers that still carry nothing.
 */
const ACKNOWLEDGEMENT_RE =
  /^(ja|nein|ok|okay|klar|passt|danke|dankeschön|gerne|jep|jup|genau|richtig|stimmt|yes|no|sure|thanks|thx|nope|yep)[\s!.,:;)-]*$/i;

/**
 * An answer to a question the assistant just asked is the one case where the
 * message itself carries no first-person marker and still states a fact —
 * because the subject is in the question, not the answer.
 *
 * Seen live: asked "wo wohnst du?", the reply was "Musterstadt im
 * Bergland!". No "ich", no "mein", so the gate below rejected it and the
 * extraction never ran; the fact was only stored two messages later when the
 * user asked whether it had been. That is exactly the shape short, important
 * answers arrive in.
 */
function isAnswerToQuestion(priorAssistantText: string | undefined): boolean {
  if (!priorAssistantText) return false;
  // Only the tail matters: a long reply that ends by asking something is
  // still a question, and one that merely contains a rhetorical "?" early on
  // is not.
  return priorAssistantText.trim().slice(-200).includes('?');
}

export function looksWorthExtracting(text: string, priorAssistantText?: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || ACKNOWLEDGEMENT_RE.test(trimmed)) return false;
  if (isAnswerToQuestion(priorAssistantText)) return true;
  if (trimmed.length < MIN_LENGTH) return false;
  if (SELF_STATEMENT_RE.test(trimmed)) return true;
  return WEAK_SELF_RE.test(trimmed) && STANDING_RULE_RE.test(trimmed) && !trimmed.endsWith('?');
}

/** Did the model already save something during the reply? Then leave it alone. */
export function alreadySavedDuringReply(trace: TraceEvent[]): boolean {
  return trace.some((e) => e.type === 'tool' && e.name === 'remember_fact');
}

/**
 * Confidence ceiling for anything this pass produces, which puts it under
 * DRAFT_CONFIDENCE_THRESHOLD and therefore into review rather than into use.
 */
const EXTRACTED_CONFIDENCE = 0.4;

const EXTRACT_TOOL = {
  type: 'function',
  function: {
    name: 'remember_fact',
    description:
      'Record one durable fact the user stated about themselves: their name, language, age, the hardware they own, the software and services they run, what they are working on, how they want answers written. Call it once per fact.',
    parameters: {
      type: 'object',
      properties: {
        fact: {
          type: 'string',
          description:
            "The fact, one sentence, in the user's language, with [[double brackets]] around the things it is about.",
        },
        type: {
          type: 'string',
          enum: ['identity', 'state', 'preference', 'episodic'],
          description:
            'identity: durable traits — name, age, language, hardware they own. state: their current situation, which will change. preference: how they want you to work. episodic: something that happened at a point in time.',
        },
        subject: {
          type: 'string',
          description: 'What the fact is about, one to three words ("grafikkarte", "name").',
        },
        /*
        A list, because inline [[brackets]] are the part models drop first:
        every fact this pass produced in testing had a usable subject and no
        brackets at all, which left the knowledge graph empty. A named array
        field is structure the model fills in reliably.
        */
        entities: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The named things this fact is about — devices, software, places, people, projects. E.g. ["Musterstadt"] or ["Grafikkarte", "Homeserver"]. Leave out plain values like numbers or dates.',
        },
      },
      required: ['fact'],
    },
  },
};

interface ToolCall {
  function?: { name?: string; arguments?: unknown };
}

export interface ExtractResult {
  /** How many new drafts were written. */
  saved: number;
  /** Facts the model proposed that were already known. */
  duplicates: number;
}

/**
 * Asks the given model, in one focused call, whether `userText` contained
 * durable facts — and writes whatever it names as drafts.
 *
 * Never throws: this runs after the user already has their answer, and a
 * failed extraction must not turn a finished reply into an error.
 */
export async function extractDurableFacts(params: {
  base: string;
  model: string;
  userText: string;
  /** The reply before it, so an answer to a question can be read in context. */
  priorAssistantText?: string;
  sessionId: string | null;
  signal?: AbortSignal;
}): Promise<ExtractResult> {
  const empty: ExtractResult = { saved: 0, duplicates: 0 };
  if (!looksWorthExtracting(params.userText, params.priorAssistantText)) return empty;

  // Naming what is already stored keeps the pass from re-proposing the same
  // fact after every message, which would fill the review queue with noise.
  const known = listMemories({ status: 'active' })
    .slice(0, 40)
    .map((m) => `- ${stripWikiLinks(m.content)}`)
    .join('\n');

  const system =
    'You extract durable facts about the user from a single message, for a long-term memory. ' +
    'Call remember_fact once for each fact the message states about the user themselves — ' +
    'their name, age, language, where they live, the hardware they own, the software they run, ' +
    'what they are working on, how they want answers written. A question can still state a ' +
    'fact: "reicht meine Grafikkarte?" states which card they own. If the message answers a ' +
    'question you just asked, read it together with that question: asked where they live, ' +
    '"Musterstadt!" states where they live. ' +
    'Do not call it for anything else: not for questions, not for what they asked you to do ' +
    'now, not for anything only true inside this one conversation.' +
    (known ? `\n\nAlready stored, do not repeat these:\n${known}` : '') +
    '\n\nIf the message contains no such fact, reply with the single word NONE and call nothing.';

  return await callExtractor({
    base: params.base,
    model: params.model,
    system,
    // The preceding reply is included as its own turn rather than quoted
    // into the user message: "Musterstadt!" means nothing without the
    // question it answers, and a model reads a real exchange more reliably
    // than a described one.
    priorAssistant: params.priorAssistantText?.slice(-1500),
    user: params.userText,
    sessionId: params.sessionId,
    signal: params.signal,
  });
}

/**
 * The one place that talks to the model and turns whatever it calls into
 * stored drafts. Shared by both passes so the two cannot drift apart in how
 * they parse a tool call or what confidence they write at — which is exactly
 * the kind of difference that would go unnoticed until one of them quietly
 * stopped saving anything.
 */
async function callExtractor(params: {
  base: string;
  model: string;
  system: string;
  user: string;
  priorAssistant?: string;
  sessionId: string | null;
  signal?: AbortSignal;
}): Promise<ExtractResult> {
  const empty: ExtractResult = { saved: 0, duplicates: 0 };
  let data: { message?: { tool_calls?: ToolCall[] } };
  try {
    const res = await fetch(`${params.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        stream: false,
        // No thinking: this is a classification, and on a reasoning model the
        // thought costs more than the answer.
        think: false,
        messages: [
          { role: 'system', content: params.system },
          ...(params.priorAssistant ? [{ role: 'assistant', content: params.priorAssistant }] : []),
          { role: 'user', content: params.user },
        ],
        tools: [EXTRACT_TOOL],
        options: { temperature: 0 },
      }),
      signal: params.signal ?? AbortSignal.timeout(180_000),
    });
    if (!res.ok) return empty;
    data = await res.json();
  } catch {
    return empty; // unreachable host, timeout, abort — all fine to drop
  }

  const result: ExtractResult = { saved: 0, duplicates: 0 };
  for (const call of data.message?.tool_calls ?? []) {
    if (call.function?.name !== 'remember_fact') continue;
    const args = (
      typeof call.function.arguments === 'string'
        ? safeParse(call.function.arguments)
        : call.function.arguments
    ) as { fact?: unknown; type?: unknown; subject?: unknown; entities?: unknown } | null;
    const fact = typeof args?.fact === 'string' ? args.fact.trim() : '';
    if (!fact) continue;
    const stored = remember({
      content: fact,
      entities: Array.isArray(args?.entities)
        ? args.entities.filter((e): e is string => typeof e === 'string')
        : undefined,
      type: isMemoryType(args?.type) ? (args.type as MemoryType) : undefined,
      subject:
        typeof args?.subject === 'string' && args.subject.trim() ? args.subject.trim() : undefined,
      confidence: EXTRACTED_CONFIDENCE,
      sourceSessionId: params.sessionId,
    });
    if (stored.duplicate) result.duplicates++;
    else result.saved++;
  }
  return result;
}

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Reads a whole past conversation at once, rather than one message at a time.
 *
 * Measured on the same ten-turn conversation against a local 35B model:
 * message by message it found **one** fact in five model calls; the same
 * conversation handed over as one transcript found **three** in a single
 * call, with entities. Both numbers matter. The extra facts come from
 * context the per-message pass cannot have — "auf einem Homeserver bei mir
 * im Keller" only states where something runs if the question before it is
 * visible — and one call per conversation instead of one per message is the
 * difference between minutes and an hour over a long history.
 *
 * This is for the backfill. The live pass stays per-message, because there
 * only one message is new.
 */
export async function extractFromConversation(params: {
  base: string;
  model: string;
  turns: ConversationTurn[];
  sessionId: string | null;
  signal?: AbortSignal;
}): Promise<ExtractResult> {
  const empty: ExtractResult = { saved: 0, duplicates: 0 };
  // Nothing to read if the user never said anything substantial.
  if (!params.turns.some((t) => t.role === 'user' && t.content.trim().length >= MIN_LENGTH)) {
    return empty;
  }

  const known = listMemories({ status: 'active' })
    .slice(0, 40)
    .map((m) => `- ${stripWikiLinks(m.content)}`)
    .join('\n');

  const system =
    'You extract durable facts about the user from a past conversation, for a long-term memory. ' +
    'Call remember_fact once for each fact the user states about themselves — their name, age, ' +
    'language, where they live, the hardware they own, the software and services they run, what ' +
    'they are working on, how they want answers written. A question can state a fact, and so can ' +
    'an answer read together with the question before it. Do not call it for anything that is ' +
    'only true inside this one conversation, and not for what the assistant said.' +
    (known ? `\n\nAlready stored, do not repeat these:\n${known}` : '') +
    '\n\nIf the conversation contains no such fact, reply with NONE and call nothing.' +
    /*
    Last, because it is the instruction most easily lost: with it earlier in
    the prompt the same German conversation came back with English facts. The
    transcript labels and this prompt are English, which pulls the model that
    way, and a fact is stored to be read back to this user later.
    */
    '\n\nWrite every fact in the same language the user writes in.';

  const transcript = params.turns
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content.trim()}`)
    .join('\n');

  return await callExtractor({
    base: params.base,
    model: params.model,
    system,
    user: `Here is a past conversation:\n\n${transcript}`,
    sessionId: params.sessionId,
    signal: params.signal,
  });
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
