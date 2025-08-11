// Server-only host resolution including DB access (not for Edge runtime)
import { validateHost } from '@/lib/env';
import { getActiveHost } from '@/lib/db';
import type { NextRequest } from 'next/server';

export function resolveOllamaHostServer(req?: NextRequest): string | null {
  // New precedence (no fallback): header > active DB host > cookie > (none)
  const header = req?.headers.get('x-ollama-host');
  if (header) {
    const v = validateHost(header);
    if (v) return v;
  }
  try {
    const active = getActiveHost();
    if (active?.url) {
      const v = validateHost(active.url);
      if (v) return v;
    }
  } catch {
    /* ignore */
  }
  return null; // explicit: no host configured
}
