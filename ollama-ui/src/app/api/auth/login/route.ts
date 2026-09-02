import { NextRequest } from 'next/server';
import {
  COOKIE_NAME,
  createSessionToken,
  isAuthEnabled,
  sessionCookieOptions,
  verifyPassword,
} from '@/lib/auth';

export const runtime = 'nodejs';

/*
Issues (POST) and clears (DELETE) the session cookie. Reachable without a
session — it's the one thing that has to be, see PUBLIC_PATHS in
src/middleware.ts.
*/

// Brute-force brake. A single-user password is short and human-chosen, so
// an unthrottled endpoint is guessable in a way a real user database isn't.
// Per-IP rather than global so one attacker can't lock the owner out.
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: NextRequest): string {
  // Behind a reverse proxy the socket address is the proxy's; the first
  // x-forwarded-for hop is the closest thing to a real client identity we
  // have. It's spoofable when the app is exposed directly, which is why
  // this is a brake on casual guessing, not the security boundary — the
  // password itself is.
  const fwd = req.headers.get('x-forwarded-for');
  return fwd?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

function rateLimited(key: string, now: number): boolean {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string, now: number): void {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count++;
  // Opportunistic sweep: without it the map grows unbounded on a
  // long-running server being scanned from many addresses.
  if (attempts.size > 1000) {
    for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
  }
}

export async function POST(req: NextRequest) {
  if (!isAuthEnabled()) {
    return Response.json({ error: 'Authentication is not configured' }, { status: 400 });
  }

  const now = Date.now();
  const key = clientKey(req);
  if (rateLimited(key, now)) {
    return Response.json(
      { error: 'Too many attempts — wait a few minutes and try again.' },
      { status: 429 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';

  if (!(await verifyPassword(password))) {
    recordFailure(key, now);
    return Response.json({ error: 'Incorrect password' }, { status: 401 });
  }

  attempts.delete(key);
  const res = Response.json({ ok: true });
  const opts = sessionCookieOptions(req.nextUrl.protocol === 'https:');
  const token = await createSessionToken();
  res.headers.append(
    'Set-Cookie',
    [
      `${opts.name}=${token}`,
      `Path=${opts.path}`,
      `Max-Age=${opts.maxAge}`,
      `SameSite=Lax`,
      opts.httpOnly ? 'HttpOnly' : '',
      opts.secure ? 'Secure' : '',
    ]
      .filter(Boolean)
      .join('; '),
  );
  return res;
}

export async function DELETE(req: NextRequest) {
  const res = Response.json({ ok: true });
  const secure = req.nextUrl.protocol === 'https:';
  res.headers.append(
    'Set-Cookie',
    [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'SameSite=Lax', 'HttpOnly', secure ? 'Secure' : '']
      .filter(Boolean)
      .join('; '),
  );
  return res;
}
