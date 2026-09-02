/**
 * Single-user password gate.
 *
 * The app exposes a lot of authority over the machine it runs on: pulling
 * and deleting models, reading the entire chat history and stored memories,
 * running arbitrary prompts through the Ollama host, and — via
 * /api/hosts/test — asking the server to fetch a URL of the caller's
 * choosing. All of that was previously reachable by anyone who could open
 * the port. Binding to localhost is the usual answer, but the whole point of
 * the Docker image and the Telegram bridge is reaching the app from
 * elsewhere, so "just don't expose it" isn't one.
 *
 * OPT-IN BY DESIGN: with APP_PASSWORD unset the gate is disabled entirely
 * and nothing changes for an existing localhost-only install. Setting it
 * turns the gate on for every route (see src/middleware.ts).
 *
 * Everything here is Web Crypto only — no `node:crypto` — because the
 * middleware that calls it runs on the Edge runtime.
 */

const COOKIE_NAME = 'ollama_ui_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const TOKEN_VERSION = 1;

export { COOKIE_NAME, SESSION_TTL_MS };

export function getConfiguredPassword(): string {
  return (process.env.APP_PASSWORD || '').trim();
}

// Auth is off unless a password is configured — see the module note.
export function isAuthEnabled(): boolean {
  return getConfiguredPassword().length > 0;
}

/*
The signing key is derived from AUTH_SECRET when set, otherwise from the
password itself. Deriving from the password is the useful default: changing
APP_PASSWORD then invalidates every existing session automatically, which is
what you want from a password change. Setting AUTH_SECRET explicitly keeps
sessions alive across a password change instead.
*/
function secretMaterial(): string {
  return process.env.AUTH_SECRET?.trim() || getConfiguredPassword();
}

let keyPromise: Promise<CryptoKey> | null = null;
let keyPromiseFor: string | null = null;

function hmacKey(): Promise<CryptoKey> {
  const material = secretMaterial();
  // Re-derive if the secret changed under us (dev server with a changed
  // .env.local), but otherwise import once — importKey on every request
  // would be pure overhead on a hot path.
  if (!keyPromise || keyPromiseFor !== material) {
    keyPromiseFor = material;
    keyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(material),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }
  return keyPromise;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array | null {
  try {
    const padded = s.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

// Length-independent equality. Comparing digests rather than the raw inputs
// means the lengths always match, so the early-out on length can't leak the
// password's length either.
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input)));
}

/*
Compares the submitted password against the configured one in constant time
— over their SHA-256 digests, so neither the comparison nor its early exit
depends on the real password's length or content. A plain `===` here would
leak both through timing on a remote login endpoint.
*/
export async function verifyPassword(submitted: string): Promise<boolean> {
  const expected = getConfiguredPassword();
  if (!expected) return false;
  const [a, b] = await Promise.all([sha256(submitted), sha256(expected)]);
  return timingSafeEqual(a, b);
}

interface TokenPayload {
  v: number;
  exp: number;
}

export async function createSessionToken(now = Date.now()): Promise<string> {
  const payload: TokenPayload = { v: TOKEN_VERSION, exp: now + SESSION_TTL_MS };
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(), new TextEncoder().encode(encoded)),
  );
  return `${encoded}.${toBase64Url(sig)}`;
}

/*
Verifies signature first, then expiry — an unsigned token is never parsed
for anything but its two segments, so a forged payload can't influence
anything before the HMAC check rejects it.
*/
export async function verifySessionToken(
  token: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return false;
  const encoded = token.slice(0, dot);
  const sigBytes = fromBase64Url(token.slice(dot + 1));
  if (!sigBytes) return false;

  const valid = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(),
    // .slice() rather than passing the view directly: fromBase64Url's
    // Uint8Array is typed over ArrayBufferLike, which SubtleCrypto's
    // BufferSource does not accept.
    sigBytes.slice().buffer,
    new TextEncoder().encode(encoded),
  );
  if (!valid) return false;

  const payloadBytes = fromBase64Url(encoded);
  if (!payloadBytes) return false;
  try {
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as TokenPayload;
    if (payload.v !== TOKEN_VERSION) return false;
    return typeof payload.exp === 'number' && payload.exp > now;
  } catch {
    return false;
  }
}

export function sessionCookieOptions(secure: boolean) {
  return {
    name: COOKIE_NAME,
    path: '/',
    // httpOnly: the token is never needed by client JS, and keeping it out
    // of document.cookie means an XSS bug can't walk off with the session.
    httpOnly: true,
    sameSite: 'lax' as const,
    // Only over HTTPS when the request itself arrived over HTTPS — forcing
    // it unconditionally would silently break the common plain-HTTP LAN
    // deployment this app is usually run as.
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  };
}
