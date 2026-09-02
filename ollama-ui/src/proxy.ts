import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE_NAME, isAuthEnabled, verifySessionToken } from '@/lib/auth';

/*
Gates the whole app behind the single-user password when APP_PASSWORD is
set; a complete no-op when it isn't (see src/lib/auth.ts for why it's
opt-in).

This is Next 16's `proxy` convention (the former `middleware.ts`, deprecated
in 16).

BUILD REQUIREMENT: the app must be built with `next build --webpack` (see
package.json). Turbopack — Next 16's default builder — compiles this file
and even lists it in the build summary as "Proxy (Middleware)", but does not
wire it into an `output: standalone` server: every request then bypasses it
entirely and the gate is silently a no-op. Renaming to `proxy.ts` turned
that silent failure into a loud one (the standalone tracer errors on a
missing `middleware.js.nft.json`), but the underlying incompatibility is the
same and the fix is the same. An auth check that fails open with no trace is
the worst way for this to break, so it is verified end-to-end rather than
assumed from a green build.

This is deliberately one proxy rather than a check inside each route
handler: there are ~30 API routes and a new one is added most weeks, and the
failure mode of "forgot to add the guard to the new route" is exactly the
one that matters. Anything reachable over HTTP goes through here.

NOT gated by this, by design, because they never touch HTTP: the Telegram
bridge and the scheduler both run in-process and call the generation engine
directly. The bridge has its own single-allowlisted-user check.
*/

// Reachable without a session: the login page itself, the endpoint that
// issues the cookie, and the favicon (so the login tab isn't blank-iconed).
const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/favicon.ico', '/ollama-ui.ico']);

export default async function proxy(req: NextRequest) {
  if (!isAuthEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (await verifySessionToken(req.cookies.get(COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  // An API caller gets a machine-readable 401 rather than the HTML of the
  // login page, so a fetch from an already-open tab whose session expired
  // fails visibly instead of parsing a redirect as data.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Authentication required', code: 'UNAUTHENTICATED' },
      {
        status: 401,
      },
    );
  }

  const loginUrl = new URL('/login', req.url);
  // Round-trip where they were headed, so logging in lands them back there.
  // Only the path+query is carried, never an absolute URL, so this can't be
  // turned into an open redirect.
  const target = pathname + req.nextUrl.search;
  if (target !== '/') loginUrl.searchParams.set('next', target);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  /*
  Everything except Next's own build output and static image assets. The
  negative lookahead keeps the proxy off the hot path for chunks and fonts,
  which carry no user data and would otherwise pay an HMAC verification per
  request.
  */
  matcher: ['/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
};
