'use client';
/*
Settings → MCP Servers.

Tools used to be fixed at build time (src/lib/generation-runner.ts), so
giving the assistant a new capability meant editing that file. This is where
you point it at an MCP server instead. The list shows what each server
actually advertises right now, because "did my config work?" is the only
question this screen exists to answer — a form that just echoes back what
was typed cannot answer it.
*/
import { useCallback, useEffect, useState } from 'react';
import { Plug, Plus, Trash2, TriangleAlert, RefreshCw, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToastStore } from '@/store/toast';

interface McpTool {
  name: string;
  description?: string;
}

interface McpServer {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  tools?: McpTool[];
  error?: string | null;
}

const EMPTY_DRAFT = {
  name: '',
  transport: 'stdio' as const,
  command: '',
  args: '',
  url: '',
};

export function McpPanel() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{
    name: string;
    transport: 'stdio' | 'http';
    command: string;
    args: string;
    url: string;
  }>({ ...EMPTY_DRAFT });
  const pushToast = useToastStore((s) => s.push);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/settings/mcp', { cache: 'no-store' });
      if (!r.ok) return;
      const data = await r.json();
      setServers(data.servers ?? []);
    } catch {
      setServers([]);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(next: McpServer[]) {
    setBusy(true);
    try {
      const r = await fetch('/api/settings/mcp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // `tools` and `error` are read-only, derived by the server on GET —
        // sending them back would just be echoing its own output at it.
        body: JSON.stringify({
          servers: next.map((s) => ({
            id: s.id,
            name: s.name,
            transport: s.transport,
            enabled: s.enabled,
            command: s.command,
            args: s.args,
            url: s.url,
          })),
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        pushToast({ type: 'error', message: data.error || 'Could not save MCP servers.' });
        return false;
      }
      // Re-read rather than trusting the local copy: the point of the list
      // is what the servers actually respond with now.
      await load();
      return true;
    } catch {
      pushToast({ type: 'error', message: 'Could not save MCP servers.' });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function addServer() {
    const entry: McpServer = {
      id: '', // derived server-side from the name
      name: draft.name,
      transport: draft.transport,
      enabled: true,
      ...(draft.transport === 'stdio'
        ? {
            command: draft.command,
            // Whitespace-separated, which covers the shape people paste from
            // a server's README ("npx -y @scope/server").
            args: draft.args.split(/\s+/).filter(Boolean),
          }
        : { url: draft.url }),
    };
    if (await save([...(servers ?? []), entry])) {
      setDraft({ ...EMPTY_DRAFT });
      setAdding(false);
    }
  }

  function removeServer(id: string) {
    void save((servers ?? []).filter((s) => s.id !== id));
  }

  function toggleServer(id: string, enabled: boolean) {
    void save((servers ?? []).map((s) => (s.id === id ? { ...s, enabled } : s)));
  }

  if (servers === null) return <div className="text-xs text-white/40">Loading…</div>;

  return (
    <div className="flex flex-col gap-4">
      {servers.length === 0 && !adding && (
        <p className="text-xs text-white/40">
          No MCP servers configured. Add one to give the assistant tools beyond the built-in set.
        </p>
      )}

      {servers.map((server) => (
        <div key={server.id} className="rounded-lg border border-white/10 bg-white/5 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Plug className="h-3.5 w-3.5 shrink-0 text-white/50" aria-hidden />
                <span className="truncate text-sm font-medium text-white/85">{server.name}</span>
                <span className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/45">
                  {server.id}
                </span>
              </div>
              <p className="mt-1 truncate font-mono text-[11px] text-white/35">
                {server.transport === 'stdio'
                  ? [server.command, ...(server.args ?? [])].join(' ')
                  : server.url}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-white/50">
                <input
                  type="checkbox"
                  checked={server.enabled}
                  onChange={(e) => toggleServer(server.id, e.target.checked)}
                  className="h-3.5 w-3.5 accent-[rgb(var(--accent-glow))]"
                />
                Enabled
              </label>
              <button
                type="button"
                onClick={() => removeServer(server.id)}
                title="Remove server"
                className="rounded p-1 text-white/30 transition hover:bg-white/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          {server.error ? (
            <div className="mt-2 flex items-start gap-2 rounded border border-amber-400/20 bg-amber-400/5 p-2 text-[11px] text-amber-200/90">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span className="break-words">{server.error}</span>
            </div>
          ) : server.enabled ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <Check className="h-3 w-3 text-emerald-300" aria-hidden />
              <span className="text-[11px] text-white/45">
                {server.tools?.length ?? 0} tool{server.tools?.length === 1 ? '' : 's'}:
              </span>
              {(server.tools ?? []).map((t) => (
                <span
                  key={t.name}
                  title={t.description}
                  className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/60"
                >
                  {t.name}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}

      {adding ? (
        <div className="flex flex-col gap-3 rounded-lg border border-white/15 bg-white/5 p-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="mcp-name" className="text-[11px] text-white/50">
              Name
            </label>
            <input
              id="mcp-name"
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder="Filesystem"
              className="h-9 rounded-lg border border-white/10 bg-black/25 px-3 text-sm text-white/90 outline-none focus:border-white/30"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="mcp-transport" className="text-[11px] text-white/50">
              Transport
            </label>
            <select
              id="mcp-transport"
              value={draft.transport}
              onChange={(e) =>
                setDraft((d) => ({ ...d, transport: e.target.value as 'stdio' | 'http' }))
              }
              className="h-9 rounded-lg border border-white/10 bg-black/25 px-2 text-sm text-white/90 outline-none focus:border-white/30"
            >
              <option value="stdio">stdio (local command)</option>
              <option value="http">http (remote URL)</option>
            </select>
          </div>

          {draft.transport === 'stdio' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="mcp-command" className="text-[11px] text-white/50">
                  Command
                </label>
                <input
                  id="mcp-command"
                  value={draft.command}
                  onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
                  placeholder="npx"
                  className="h-9 rounded-lg border border-white/10 bg-black/25 px-3 font-mono text-sm text-white/90 outline-none focus:border-white/30"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label htmlFor="mcp-args" className="text-[11px] text-white/50">
                  Arguments
                </label>
                <input
                  id="mcp-args"
                  value={draft.args}
                  onChange={(e) => setDraft((d) => ({ ...d, args: e.target.value }))}
                  placeholder="-y @modelcontextprotocol/server-filesystem /Users/me/notes"
                  className="h-9 rounded-lg border border-white/10 bg-black/25 px-3 font-mono text-sm text-white/90 outline-none focus:border-white/30"
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="mcp-url" className="text-[11px] text-white/50">
                URL
              </label>
              <input
                id="mcp-url"
                value={draft.url}
                onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
                placeholder="https://example.com/mcp"
                className="h-9 rounded-lg border border-white/10 bg-black/25 px-3 font-mono text-sm text-white/90 outline-none focus:border-white/30"
              />
            </div>
          )}

          <div className="flex gap-2">
            <Button size="sm" onClick={addServer} loading={busy} disabled={!draft.name.trim()}>
              Add server
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdding(false);
                setDraft({ ...EMPTY_DRAFT });
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <span className="inline-flex items-center gap-1.5">
              <Plus className="h-3.5 w-3.5" /> Add MCP server
            </span>
          </Button>
          {servers.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => void load()} loading={busy}>
              <span className="inline-flex items-center gap-1.5">
                <RefreshCw className="h-3.5 w-3.5" /> Recheck
              </span>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
