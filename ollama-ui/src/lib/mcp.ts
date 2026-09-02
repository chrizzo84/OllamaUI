/**
 * Minimal Model Context Protocol client.
 *
 * Why this exists: every tool the assistant can call was hard-coded in
 * src/lib/generation-runner.ts, so adding one meant editing that file and
 * redeploying. MCP is the standard way to hand a model tools it wasn't
 * built with, and a local-first app is exactly where that matters — the
 * useful tools are the ones that touch your own machine and services.
 *
 * WHAT IS IMPLEMENTED: the client half of the parts a chat app needs —
 * `initialize`, `tools/list`, `tools/call` — over the two transports people
 * actually run servers on:
 *
 *   stdio  spawn a command, exchange newline-delimited JSON-RPC 2.0 on its
 *          stdin/stdout. This is how nearly every local MCP server ships.
 *   http   POST JSON-RPC to a URL (Streamable HTTP), reading either a JSON
 *          response or a `text/event-stream` one.
 *
 * NOT implemented: resources, prompts, sampling, server-initiated
 * notifications and roots. Nothing here needs them, and a partial version
 * of each would be worse than their honest absence. If one becomes
 * necessary, this is the file to grow.
 *
 * Deliberately hand-rolled rather than pulling in the official SDK: the
 * request/response subset above is small and stable, whereas the app builds
 * with `output: standalone`, where every dependency has to be traced into
 * the bundle correctly — and this app has already been bitten by exactly
 * that class of packaging problem (see the better-sqlite3 note in the
 * README).
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'ollama-ui', version: '1.0.0' };

// A server that never answers must not hold a chat turn open forever.
const REQUEST_TIMEOUT_MS = 30_000;
const INITIALIZE_TIMEOUT_MS = 15_000;

/*
Tool names are namespaced with the server id before being shown to the
model, so two servers offering a `search` tool stay distinguishable and
neither can shadow a built-in tool. The separator is chosen to survive the
`^[a-zA-Z0-9_-]+$` shape function names are expected to have.
*/
const NAMESPACE_SEPARATOR = '__';

export function namespacedToolName(serverId: string, toolName: string): string {
  return `mcp${NAMESPACE_SEPARATOR}${serverId}${NAMESPACE_SEPARATOR}${toolName}`;
}

export function parseNamespacedToolName(
  name: string,
): { serverId: string; toolName: string } | null {
  if (!name.startsWith(`mcp${NAMESPACE_SEPARATOR}`)) return null;
  const rest = name.slice(`mcp${NAMESPACE_SEPARATOR}`.length);
  const idx = rest.indexOf(NAMESPACE_SEPARATOR);
  if (idx <= 0) return null;
  return {
    serverId: rest.slice(0, idx),
    toolName: rest.slice(idx + NAMESPACE_SEPARATOR.length),
  };
}

abstract class McpTransport {
  abstract request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  abstract notify(method: string, params: unknown): Promise<void>;
  abstract close(): void;
}

/*
stdio transport. The server is a child process; requests go to its stdin and
responses come back on stdout, one JSON object per line. stderr is left
attached to the parent's so a server's own diagnostics end up in the app's
logs rather than vanishing.
*/
class StdioTransport extends McpTransport {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;

  constructor(config: McpServerConfig) {
    super();
    if (!config.command) throw new Error('stdio server needs a command');
    this.child = spawn(config.command, config.args ?? [], {
      // The server inherits the app's environment plus its own overrides —
      // most servers need PATH and HOME at minimum, so starting from an
      // empty environment would break the common case.
      env: { ...process.env, ...(config.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    this.child.stdout.on('data', (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on('data', (chunk: Buffer) => {
      console.error(`[mcp:${config.id}] ${chunk.toString().trimEnd()}`);
    });
    this.child.on('error', (e) => this.failAll(new Error(`server process error: ${e.message}`)));
    this.child.on('exit', (code) =>
      this.failAll(new Error(`server process exited (code ${code ?? 'unknown'})`)),
    );
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // a server logging plain text to stdout is not fatal
      }
      if (typeof msg.id !== 'number') continue; // notification from the server: ignored
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      clearTimeout(waiter.timer);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    }
  }

  private failAll(error: Error) {
    this.closed = true;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('server connection is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.closed) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  close(): void {
    this.closed = true;
    this.failAll(new Error('closed'));
    this.child.kill();
  }
}

/*
Streamable HTTP transport. Each request is its own POST; the server may
answer with plain JSON or with an SSE stream, so both are handled. A session
id handed back on initialize is echoed on later requests, which is how the
spec keeps a stateful server's context.
*/
class HttpTransport extends McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(private config: McpServerConfig) {
    super();
    if (!config.url) throw new Error('http server needs a url');
  }

  private async send(body: unknown, timeoutMs: number): Promise<Response> {
    return fetch(this.config.url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...(this.config.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.send({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    const handedSession = res.headers.get('Mcp-Session-Id');
    if (handedSession) this.sessionId = handedSession;
    if (!res.ok) throw new Error(`HTTP ${res.status} from MCP server`);

    const raw = await res.text();
    const message = res.headers.get('Content-Type')?.includes('text/event-stream')
      ? extractSseJson(raw)
      : raw;
    if (!message) throw new Error('empty response from MCP server');

    const parsed = JSON.parse(message) as JsonRpcResponse;
    if (parsed.error) throw new Error(parsed.error.message);
    return parsed.result;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.send({ jsonrpc: '2.0', method, params }, REQUEST_TIMEOUT_MS).catch(() => {
      /* notifications are fire-and-forget by definition */
    });
  }

  close(): void {
    /* stateless between requests; nothing to tear down */
  }
}

// Pulls the last `data:` payload out of an SSE body — the JSON-RPC response
// for a request that the server chose to answer as a stream.
function extractSseJson(raw: string): string | null {
  const payloads = raw
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((l) => l && l !== '[DONE]');
  return payloads.length ? payloads[payloads.length - 1] : null;
}

class McpConnection {
  private transport: McpTransport;
  private ready: Promise<void>;

  constructor(private config: McpServerConfig) {
    this.transport =
      config.transport === 'http' ? new HttpTransport(config) : new StdioTransport(config);
    this.ready = this.handshake();
  }

  private async handshake(): Promise<void> {
    await this.transport.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        // Honest about what this client can do: declaring capabilities it
        // does not implement would invite a server to use them.
        capabilities: {},
        clientInfo: CLIENT_INFO,
      },
      INITIALIZE_TIMEOUT_MS,
    );
    await this.transport.notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.ready;
    const result = (await this.transport.request('tools/list', {}, REQUEST_TIMEOUT_MS)) as {
      tools?: McpToolDefinition[];
    };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name: string, args: unknown): Promise<unknown> {
    await this.ready;
    return this.transport.request(
      'tools/call',
      { name, arguments: args ?? {} },
      REQUEST_TIMEOUT_MS,
    );
  }

  close(): void {
    this.transport.close();
  }
}

/*
One live connection per configured server, kept for the life of the process.

A stdio server costs a process spawn and a handshake to reach, which is far
too much to pay on every tool call inside a single chat turn. A connection
that has failed is dropped from the pool so the next attempt reconnects
rather than reusing a dead child process.
*/
const pool = new Map<string, McpConnection>();

function connect(config: McpServerConfig): McpConnection {
  const existing = pool.get(config.id);
  if (existing) return existing;
  const created = new McpConnection(config);
  pool.set(config.id, created);
  return created;
}

export function disconnectServer(serverId: string): void {
  const existing = pool.get(serverId);
  if (!existing) return;
  pool.delete(serverId);
  existing.close();
}

export function disconnectAll(): void {
  for (const id of [...pool.keys()]) disconnectServer(id);
}

export interface McpServerTools {
  serverId: string;
  serverName: string;
  tools: McpToolDefinition[];
  error?: string;
}

/*
Tools from every enabled server, asked in parallel.

A server that is down, misconfigured or slow yields an error entry rather
than throwing: one broken MCP server must not cost the user the ability to
chat, or take the working servers' tools down with it.
*/
export async function listAllTools(configs: McpServerConfig[]): Promise<McpServerTools[]> {
  const enabled = configs.filter((c) => c.enabled);
  return Promise.all(
    enabled.map(async (config) => {
      try {
        return {
          serverId: config.id,
          serverName: config.name,
          tools: await connect(config).listTools(),
        };
      } catch (e) {
        disconnectServer(config.id);
        return {
          serverId: config.id,
          serverName: config.name,
          tools: [],
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }),
  );
}

export async function callTool(
  configs: McpServerConfig[],
  serverId: string,
  toolName: string,
  args: unknown,
): Promise<{ result?: unknown; error?: string }> {
  const config = configs.find((c) => c.id === serverId && c.enabled);
  if (!config) return { error: `MCP server "${serverId}" is not configured or is disabled` };
  try {
    return { result: normalizeToolResult(await connect(config).callTool(toolName, args)) };
  } catch (e) {
    // Drop the connection so a transient failure doesn't poison every later
    // call in this process.
    disconnectServer(serverId);
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/*
Flattens MCP's content-block result into something a model reads well.

The protocol returns `{ content: [{type:'text', text}, ...], isError? }`.
Handing that structure to the model verbatim buries the answer inside
protocol scaffolding, so text blocks are joined into a plain string; other
block types are described rather than dropped, so the model is not silently
told nothing happened.
*/
export function normalizeToolResult(raw: unknown): unknown {
  const result = raw as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  if (result?.structuredContent !== undefined) return result.structuredContent;
  if (!Array.isArray(result?.content)) return raw;

  const parts = (result.content as Array<Record<string, unknown>>).map((block) => {
    if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    if (block?.type === 'image') return '[image returned by tool]';
    if (block?.type === 'resource') return `[resource: ${String(block.uri ?? 'unknown')}]`;
    return JSON.stringify(block);
  });
  const text = parts.join('\n').trim();
  if (result.isError) return { error: text || 'tool reported an error' };
  return text || null;
}

// An MCP tool description in the shape Ollama's function-calling API wants.
export function toOllamaTool(serverId: string, tool: McpToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: namespacedToolName(serverId, tool.name),
      description: tool.description ?? `Tool "${tool.name}" from MCP server "${serverId}"`,
      // A schema-less tool still has to declare *something*, or models
      // reliably refuse to call it.
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  };
}
