import type { NextConfig } from 'next';
import os from 'os';

// Dynamisch alle lokalen IPv4 Interfaces sammeln, um Dev-Origin-Warnung zu vermeiden.
// DISCLAIMER: Das wirkt nur in Entwicklung; in Production ignoriert Next dieses Feld.
function collectLocalOrigins(port = 3000): string[] {
  try {
    const ifaces = os.networkInterfaces();
    const ips = Object.values(ifaces)
      .flat()
      .filter((i): i is NonNullable<typeof i> => !!i && i.family === 'IPv4' && !i.internal)
      .map((i) => `http://${i.address}:${port}`);
    return ips;
  } catch {
    return [];
  }
}

const envOrigins = (process.env.ALLOWED_DEV_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const baseOrigins = ['http://localhost:3000', 'http://127.0.0.1:3000'];

const autoOrigins = collectLocalOrigins(3000);
const allowedDevOrigins = Array.from(new Set([...baseOrigins, ...autoOrigins, ...envOrigins]));

const nextConfig: NextConfig = {
  output: 'standalone',
  // Offizielle Lösung für die Warnung: explizit die erlaubten Dev-Origns setzen.
  // Wildcards sind NICHT erlaubt; deshalb enumerieren wir dynamisch.
  // Entferne/vereinfachen, falls zu großzügig.
  allowedDevOrigins,
  // eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
