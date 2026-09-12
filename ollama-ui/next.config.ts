import type { NextConfig } from 'next';
import os from 'os';

/*
Next blocks requests for /_next/* dev resources whose Origin isn't allowlisted.
Reaching a dev server from another device on the LAN — a phone, or just the
machine's own address rather than localhost — therefore serves the HTML and
then blocks every chunk behind it. The page loads and nothing on it works,
which looks like the app is broken rather than like a bundler policy.

The entries are HOSTNAMES, not origins: "192.168.1.5", not
"http://192.168.1.5:3000". The previous version stored full URLs with a
hard-coded port, so nothing ever matched and the allowlist had no effect —
the warning Next prints names exactly the form it wants.
*/
function localHostnames(): string[] {
  try {
    return Object.values(os.networkInterfaces())
      .flat()
      .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
      .map((i) => i.address);
  } catch {
    return [];
  }
}

// Anything else that should reach the dev server: a hostname per entry,
// comma-separated (ALLOWED_DEV_ORIGINS=mac.local,192.168.1.20).
const envOrigins = (process.env.ALLOWED_DEV_ORIGINS || '')
  .split(',')
  .map((s) =>
    s
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/:\d+$/, ''),
  )
  .filter(Boolean);

const allowedDevOrigins = Array.from(
  new Set(['localhost', '127.0.0.1', ...localHostnames(), ...envOrigins]),
);

const nextConfig: NextConfig = {
  output: 'standalone',
  // Development only — Next ignores this in a production build.
  allowedDevOrigins,
};

export default nextConfig;
