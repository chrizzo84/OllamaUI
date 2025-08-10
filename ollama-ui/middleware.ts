import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Global permissive CORS (use with caution in production!)
// Matches all /api/* routes (configured below).
// If you need credentials (cookies, auth headers), replace '*' with an explicit origin reflection logic.
const ALLOW_ORIGIN = '*';
const ALLOW_METHODS = 'GET,POST,PUT,PATCH,DELETE,OPTIONS';
const ALLOW_HEADERS = '*';
const MAX_AGE = '600';

export function middleware(req: NextRequest) {
  const { method } = req;

  // Preflight: respond immediately
  if (method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: buildHeaders(),
    });
  }

  const res = NextResponse.next();
  const headers = buildHeaders();
  headers.forEach((v, k) => res.headers.set(k, v));
  return res;
}

function buildHeaders(): Headers {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  h.set('Vary', 'Origin');
  h.set('Access-Control-Allow-Methods', ALLOW_METHODS);
  h.set('Access-Control-Allow-Headers', ALLOW_HEADERS);
  h.set('Access-Control-Max-Age', MAX_AGE);
  return h;
}

// Apply to API routes and Next.js asset/static routes so cross-origin dev access works.
// Note: Over-broad CORS ('*') on _next assets is generally safe; if you add credentials, tighten origins.
export const config = {
  matcher: ['/api/:path*', '/_next/:path*', '/favicon.ico', '/assets/:path*'],
};
