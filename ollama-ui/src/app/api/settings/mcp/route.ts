import { NextRequest } from 'next/server';
import { listMcpServers, saveMcpServers, validateMcpServer } from '@/lib/mcp-settings';
import { disconnectServer, listAllTools } from '@/lib/mcp';
import type { McpServerConfig } from '@/lib/mcp';

export const runtime = 'nodejs';

/*
GET  — the configured servers, each with the tools it currently advertises
       (or the error explaining why it can't be reached). Actually
       connecting on read is the point: "I added the server, is it working?"
       is the only question this page exists to answer, and a list that just
       echoes back what was typed in cannot answer it.
PUT  — replace the whole list.
*/
export async function GET() {
  const servers = listMcpServers();
  const tools = await listAllTools(servers);
  const byServer = new Map(tools.map((t) => [t.serverId, t]));
  return Response.json({
    servers: servers.map((s) => ({
      ...s,
      tools: byServer.get(s.id)?.tools ?? [],
      error: byServer.get(s.id)?.error ?? null,
    })),
  });
}

export async function PUT(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const incoming: Array<Partial<McpServerConfig>> = Array.isArray(body.servers) ? body.servers : [];

  const validated: McpServerConfig[] = [];
  for (const entry of incoming) {
    const { server, error } = validateMcpServer(entry);
    if (error) return Response.json({ error }, { status: 400 });
    if (validated.some((s) => s.id === server!.id)) {
      return Response.json(
        { error: `Two servers would share the id "${server!.id}" — give them different names.` },
        { status: 400 },
      );
    }
    validated.push(server!);
  }

  /*
  Drop live connections for anything whose definition changed or that is
  gone: a pooled stdio child process was started from the OLD command, so
  reusing it after an edit would silently keep running the previous server.
  */
  const previous = listMcpServers();
  for (const old of previous) {
    const next = validated.find((s) => s.id === old.id);
    if (!next || JSON.stringify(next) !== JSON.stringify(old)) disconnectServer(old.id);
  }

  saveMcpServers(validated);
  return Response.json({ servers: validated });
}
