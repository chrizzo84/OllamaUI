// Server-only host resolution including DB access (not for Edge runtime)
import { validateHost } from '@/lib/env';
import { getActiveHost } from '@/lib/db';

// The active host from the DB is the only source. An `x-ollama-host`
// request header used to override this, but nothing in the app ever sent
// one: the host is chosen in the Host Manager, which writes it to the
// `hosts` table. All the header actually did was let any request that
// reached the server point it at an arbitrary URL and read the response
// back through the chat/model routes — a server-side request forgery hole
// with no feature behind it. Changing the host is done through
// /api/hosts (activateHost), which is a real, auditable state change.
export function resolveOllamaHostServer(): string | null {
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
