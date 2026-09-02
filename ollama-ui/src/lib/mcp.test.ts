import { describe, it, expect, afterEach } from 'vitest';
import {
  namespacedToolName,
  parseNamespacedToolName,
  normalizeToolResult,
  toOllamaTool,
  listAllTools,
  callTool,
  disconnectAll,
  type McpServerConfig,
} from './mcp';
import { validateMcpServer } from './mcp-settings';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

afterEach(() => disconnectAll());

describe('tool namespacing', () => {
  it('round-trips', () => {
    const name = namespacedToolName('github', 'search_issues');
    expect(parseNamespacedToolName(name)).toEqual({
      serverId: 'github',
      toolName: 'search_issues',
    });
  });

  it('produces a name a function-calling API will accept', () => {
    expect(namespacedToolName('my-server', 'do_thing')).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('leaves built-in tool names alone', () => {
    expect(parseNamespacedToolName('web_search')).toBeNull();
    expect(parseNamespacedToolName('calculator')).toBeNull();
  });

  it('keeps a tool name containing the separator intact', () => {
    expect(parseNamespacedToolName(namespacedToolName('s', 'a__b'))).toEqual({
      serverId: 's',
      toolName: 'a__b',
    });
  });

  it('rejects a malformed namespaced name', () => {
    expect(parseNamespacedToolName('mcp__')).toBeNull();
    expect(parseNamespacedToolName('mcp__onlyserver')).toBeNull();
  });
});

describe('normalizeToolResult', () => {
  it('flattens text content blocks into a plain string', () => {
    expect(
      normalizeToolResult({
        content: [
          { type: 'text', text: 'line 1' },
          { type: 'text', text: 'line 2' },
        ],
      }),
    ).toBe('line 1\nline 2');
  });

  it('prefers structuredContent when the server provides it', () => {
    expect(
      normalizeToolResult({
        structuredContent: { temp: 21 },
        content: [{ type: 'text', text: '21' }],
      }),
    ).toEqual({ temp: 21 });
  });

  it('surfaces an error result as an error rather than as prose', () => {
    expect(
      normalizeToolResult({ isError: true, content: [{ type: 'text', text: 'nope' }] }),
    ).toEqual({
      error: 'nope',
    });
  });

  it('describes non-text blocks instead of silently dropping them', () => {
    expect(normalizeToolResult({ content: [{ type: 'image', data: 'x' }] })).toBe(
      '[image returned by tool]',
    );
    expect(normalizeToolResult({ content: [{ type: 'resource', uri: 'file://a' }] })).toBe(
      '[resource: file://a]',
    );
  });

  it('returns null for an empty result rather than an empty string', () => {
    expect(normalizeToolResult({ content: [] })).toBeNull();
  });

  it('passes through a shape it does not recognise', () => {
    expect(normalizeToolResult({ unexpected: 1 })).toEqual({ unexpected: 1 });
  });
});

describe('toOllamaTool', () => {
  it('maps name, description and schema', () => {
    const tool = toOllamaTool('srv', {
      name: 'lookup',
      description: 'Looks things up',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    });
    expect(tool.function.name).toBe('mcp__srv__lookup');
    expect(tool.function.description).toBe('Looks things up');
    expect(tool.function.parameters).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    });
  });

  it('substitutes a description when the server gives none', () => {
    expect(toOllamaTool('srv', { name: 'x' }).function.description).toContain('srv');
  });

  it('always declares a parameter schema — models refuse tools without one', () => {
    expect(toOllamaTool('srv', { name: 'x' }).function.parameters).toEqual({
      type: 'object',
      properties: {},
    });
  });
});

describe('validateMcpServer', () => {
  it('derives a function-name-safe id from the display name', () => {
    const { server } = validateMcpServer({ name: 'My GitHub Server!', command: 'x' });
    expect(server!.id).toBe('my-github-server');
    expect(namespacedToolName(server!.id, 't')).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('requires a name', () => {
    expect(validateMcpServer({ command: 'x' }).error).toMatch(/Name is required/);
  });

  it('requires a command for stdio', () => {
    expect(validateMcpServer({ name: 'a' }).error).toMatch(/needs a command/);
  });

  it('requires an http(s) url for http', () => {
    expect(validateMcpServer({ name: 'a', transport: 'http' }).error).toMatch(/http\(s\) URL/);
    expect(validateMcpServer({ name: 'a', transport: 'http', url: 'ftp://x' }).error).toBeTruthy();
  });

  it('accepts a valid http server', () => {
    const { server, error } = validateMcpServer({
      name: 'Remote',
      transport: 'http',
      url: 'https://mcp.example.com/rpc',
    });
    expect(error).toBeUndefined();
    expect(server!.url).toBe('https://mcp.example.com/rpc');
  });

  it('rejects a name with nothing usable in it', () => {
    expect(validateMcpServer({ name: '!!!', command: 'x' }).error).toMatch(/at least one letter/);
  });

  it('defaults to enabled', () => {
    expect(validateMcpServer({ name: 'a', command: 'x' }).server!.enabled).toBe(true);
  });

  it('respects an explicit disable', () => {
    expect(validateMcpServer({ name: 'a', command: 'x', enabled: false }).server!.enabled).toBe(
      false,
    );
  });
});

/*
End-to-end against a real MCP server: a tiny stdio server written to a temp
file and spawned for the test. Faking the transport would test the mock, not
the handshake/framing that is the actual risk here.
*/
describe('stdio transport against a real server process', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
  const serverPath = path.join(dir, 'server.mjs');
  fs.writeFileSync(
    serverPath,
    `
let buf = '';
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) !== -1) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      respond(msg.id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'test', version: '1' } });
    } else if (msg.method === 'tools/list') {
      respond(msg.id, { tools: [{ name: 'echo', description: 'Echoes', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
    } else if (msg.method === 'tools/call') {
      if (msg.params.name === 'boom') respondError(msg.id, 'tool exploded');
      else respond(msg.id, { content: [{ type: 'text', text: 'echo: ' + (msg.params.arguments?.text ?? '') }] });
    }
  }
});
function respond(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n'); }
function respondError(id, message) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -1, message } }) + '\\n'); }
`,
  );

  const config: McpServerConfig = {
    id: 'testsrv',
    name: 'Test',
    transport: 'stdio',
    command: process.execPath,
    args: [serverPath],
    enabled: true,
  };

  it('handshakes and lists tools', async () => {
    const [entry] = await listAllTools([config]);
    expect(entry.error).toBeUndefined();
    expect(entry.tools.map((t) => t.name)).toEqual(['echo']);
  });

  it('calls a tool and flattens the result', async () => {
    const out = await callTool([config], 'testsrv', 'echo', { text: 'hi' });
    expect(out.result).toBe('echo: hi');
    expect(out.error).toBeUndefined();
  });

  it('surfaces a JSON-RPC error as a tool error', async () => {
    const out = await callTool([config], 'testsrv', 'boom', {});
    expect(out.error).toBe('tool exploded');
  });

  it('refuses to call a server that is disabled', async () => {
    const out = await callTool([{ ...config, enabled: false }], 'testsrv', 'echo', {});
    expect(out.error).toMatch(/not configured or is disabled/);
  });

  it('refuses to call a server that is not configured', async () => {
    const out = await callTool([config], 'ghost', 'echo', {});
    expect(out.error).toMatch(/not configured or is disabled/);
  });

  it('reports an unstartable server without throwing', async () => {
    const [entry] = await listAllTools([
      { ...config, id: 'broken', command: '/nonexistent/binary/xyz' },
    ]);
    expect(entry.error).toBeTruthy();
    expect(entry.tools).toEqual([]);
  });

  it('keeps working servers usable when another one is broken', async () => {
    // One bad server must not cost the user every other server's tools.
    const entries = await listAllTools([
      config,
      { ...config, id: 'broken', command: '/nonexistent/binary/xyz' },
    ]);
    const ok = entries.find((e) => e.serverId === 'testsrv')!;
    const bad = entries.find((e) => e.serverId === 'broken')!;
    expect(ok.tools).toHaveLength(1);
    expect(bad.error).toBeTruthy();
  });

  it('skips servers that are disabled', async () => {
    expect(await listAllTools([{ ...config, enabled: false }])).toEqual([]);
  });
});
