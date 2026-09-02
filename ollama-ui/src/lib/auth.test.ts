import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// auth.ts caches the derived HMAC key per secret, so each test gets a fresh
// module instance to keep env changes from leaking across cases.
async function freshAuth() {
  vi.resetModules();
  return import('./auth');
}

beforeEach(() => vi.unstubAllEnvs());
afterEach(() => vi.unstubAllEnvs());

describe('isAuthEnabled', () => {
  it('is off when APP_PASSWORD is unset — an existing local install is unaffected', async () => {
    vi.stubEnv('APP_PASSWORD', '');
    expect((await freshAuth()).isAuthEnabled()).toBe(false);
  });

  it('is off when APP_PASSWORD is only whitespace', async () => {
    vi.stubEnv('APP_PASSWORD', '   ');
    expect((await freshAuth()).isAuthEnabled()).toBe(false);
  });

  it('is on once a password is configured', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    expect((await freshAuth()).isAuthEnabled()).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the configured password', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    expect(await (await freshAuth()).verifyPassword('hunter2')).toBe(true);
  });

  it.each(['wrong', '', 'hunter', 'hunter22', 'HUNTER2'])('rejects %s', async (attempt) => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    expect(await (await freshAuth()).verifyPassword(attempt)).toBe(false);
  });

  it('rejects everything when no password is configured', async () => {
    vi.stubEnv('APP_PASSWORD', '');
    const auth = await freshAuth();
    expect(await auth.verifyPassword('')).toBe(false);
    expect(await auth.verifyPassword('anything')).toBe(false);
  });

  it('ignores surrounding whitespace in the configured value', async () => {
    vi.stubEnv('APP_PASSWORD', '  hunter2  ');
    expect(await (await freshAuth()).verifyPassword('hunter2')).toBe(true);
  });
});

describe('session tokens', () => {
  it('round-trips a freshly issued token', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    const auth = await freshAuth();
    expect(await auth.verifySessionToken(await auth.createSessionToken())).toBe(true);
  });

  it('rejects an expired token', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    const auth = await freshAuth();
    const issuedAt = Date.now() - auth.SESSION_TTL_MS - 1000;
    expect(await auth.verifySessionToken(await auth.createSessionToken(issuedAt))).toBe(false);
  });

  it('accepts a token that is still just inside its window', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    const auth = await freshAuth();
    const issuedAt = Date.now() - auth.SESSION_TTL_MS + 60_000;
    expect(await auth.verifySessionToken(await auth.createSessionToken(issuedAt))).toBe(true);
  });

  it('rejects a tampered payload — the signature is checked, not just the shape', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    const auth = await freshAuth();
    const token = await auth.createSessionToken();
    const sig = token.slice(token.indexOf('.'));
    const forged = btoa(JSON.stringify({ v: 1, exp: Date.now() + 10 ** 12 }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(await auth.verifySessionToken(forged + sig)).toBe(false);
  });

  it('rejects a tampered signature', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    const auth = await freshAuth();
    const token = await auth.createSessionToken();
    const [payload] = token.split('.');
    expect(await auth.verifySessionToken(`${payload}.AAAA`)).toBe(false);
  });

  it('rejects a token signed with a different password', async () => {
    vi.stubEnv('APP_PASSWORD', 'old-password');
    const token = await (await freshAuth()).createSessionToken();
    vi.stubEnv('APP_PASSWORD', 'new-password');
    expect(await (await freshAuth()).verifySessionToken(token)).toBe(false);
  });

  it('keeps sessions valid across a password change when AUTH_SECRET is pinned', async () => {
    vi.stubEnv('AUTH_SECRET', 'stable-secret');
    vi.stubEnv('APP_PASSWORD', 'old-password');
    const token = await (await freshAuth()).createSessionToken();
    vi.stubEnv('APP_PASSWORD', 'new-password');
    expect(await (await freshAuth()).verifySessionToken(token)).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['no separator', 'abcdef'],
    ['empty payload', '.sig'],
    ['empty signature', 'payload.'],
    ['garbage', 'not-a-token-at-all'],
    ['unsigned JSON', JSON.stringify({ v: 1, exp: 9e15 })],
  ])('rejects a malformed token (%s)', async (_label, token) => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    expect(await (await freshAuth()).verifySessionToken(token)).toBe(false);
  });

  it('rejects a token from a future format version', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    const auth = await freshAuth();
    // Sign a v2 payload with the real key: only the version must reject it.
    const enc = new TextEncoder();
    const b64 = (b: Uint8Array) =>
      btoa(String.fromCharCode(...b))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    const payload = b64(enc.encode(JSON.stringify({ v: 2, exp: Date.now() + 1000 })));
    const key = await crypto.subtle.importKey(
      'raw',
      enc.encode('hunter2'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
    expect(await auth.verifySessionToken(`${payload}.${b64(sig)}`)).toBe(false);
  });

  it('issues a different token each time (the expiry moves)', async () => {
    vi.stubEnv('APP_PASSWORD', 'hunter2');
    const auth = await freshAuth();
    const a = await auth.createSessionToken(1000);
    const b = await auth.createSessionToken(2000);
    expect(a).not.toBe(b);
  });
});

describe('sessionCookieOptions', () => {
  it('is httpOnly and lax so client JS can never read the token', async () => {
    const opts = (await freshAuth()).sessionCookieOptions(false);
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
  });

  it('marks the cookie secure only for an HTTPS request', async () => {
    const auth = await freshAuth();
    expect(auth.sessionCookieOptions(true).secure).toBe(true);
    // A plain-HTTP LAN deployment is the common case; forcing secure there
    // would drop the cookie and lock the user out.
    expect(auth.sessionCookieOptions(false).secure).toBe(false);
  });

  it('expires with the token, not before it', async () => {
    const auth = await freshAuth();
    expect(auth.sessionCookieOptions(false).maxAge).toBe(Math.floor(auth.SESSION_TTL_MS / 1000));
  });
});
