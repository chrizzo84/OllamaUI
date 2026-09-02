// Server-side storage for the configured MCP servers (Settings → MCP
// Servers). Kept in the same `settings` table as the tool toggles so it is
// shared across browsers and reachable from every place a generation runs —
// the web chat, the scheduler and the Telegram bridge all read it, so a
// server added here is available everywhere rather than only in the tab
// that added it.
import { getSetting, setSetting } from '@/lib/db';
import type { McpServerConfig } from '@/lib/mcp';

const KEY = 'mcpServers';

export function listMcpServers(): McpServerConfig[] {
  const stored = getSetting<McpServerConfig[]>(KEY);
  return Array.isArray(stored) ? stored : [];
}

export function saveMcpServers(servers: McpServerConfig[]): void {
  setSetting(KEY, servers);
}

/*
Normalizes and validates one server entry coming from the settings form.

Returns an error string rather than throwing, because every one of these is
something the person filling in the form needs to read and fix.
*/
export function validateMcpServer(input: Partial<McpServerConfig>): {
  server?: McpServerConfig;
  error?: string;
} {
  const name = (input.name ?? '').trim();
  if (!name) return { error: 'Name is required.' };

  const transport = input.transport === 'http' ? 'http' : 'stdio';
  if (transport === 'stdio' && !(input.command ?? '').trim()) {
    return { error: 'A stdio server needs a command to run.' };
  }
  if (transport === 'http') {
    const url = (input.url ?? '').trim();
    if (!/^https?:\/\//.test(url)) return { error: 'An HTTP server needs an http(s) URL.' };
  }

  /*
  The id becomes part of every tool name the model sees, so it is restricted
  to what a function name may contain. Derived from the display name when
  not supplied, which keeps the tool names readable ("mcp__github__search")
  instead of showing the model a UUID.
  */
  const id = (input.id ?? name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  if (!id) return { error: 'Name must contain at least one letter or digit.' };

  return {
    server: {
      id,
      name,
      transport,
      enabled: input.enabled !== false,
      ...(transport === 'stdio'
        ? {
            command: (input.command ?? '').trim(),
            args: Array.isArray(input.args) ? input.args.filter((a) => typeof a === 'string') : [],
            env: input.env && typeof input.env === 'object' ? input.env : {},
          }
        : {
            url: (input.url ?? '').trim(),
            headers: input.headers && typeof input.headers === 'object' ? input.headers : {},
          }),
    },
  };
}
