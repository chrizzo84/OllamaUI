import { describe, it, expect } from 'vitest';
import { validateMcpServer } from './mcp-settings';

/*
The Add form (mcp-panel.tsx) posts `id: ''` and relies on the id being
derived from the name. That blank string used to survive `??`, sanitize to
nothing, and fail with an error blaming the name — so adding any server
through the UI was impossible. These pin the payload the panel actually
sends, not just the tidy shape a hand-written call would use.
*/
describe('validateMcpServer — id derivation', () => {
  const panelPayload = {
    id: '',
    name: 'GitHub',
    transport: 'stdio' as const,
    enabled: true,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
  };

  it('derives the id from the name when the form posts a blank id', () => {
    const { server, error } = validateMcpServer(panelPayload);
    expect(error).toBeUndefined();
    expect(server?.id).toBe('github');
  });

  it('treats a whitespace-only id as absent too', () => {
    const { server } = validateMcpServer({ ...panelPayload, id: '   ' });
    expect(server?.id).toBe('github');
  });

  it('derives the id when the key is missing entirely', () => {
    const { server } = validateMcpServer({ ...panelPayload, id: undefined });
    expect(server?.id).toBe('github');
  });

  it('keeps an explicit id, so renaming a server cannot change its tool names', () => {
    const { server } = validateMcpServer({ ...panelPayload, id: 'gh', name: 'GitHub Renamed' });
    expect(server?.id).toBe('gh');
    expect(server?.name).toBe('GitHub Renamed');
  });

  it('sanitizes a name down to what a function name may contain', () => {
    const { server } = validateMcpServer({ ...panelPayload, name: 'My Server (v2)!' });
    expect(server?.id).toBe('my-server-v2');
  });

  it('caps the derived id at 32 characters', () => {
    const { server } = validateMcpServer({ ...panelPayload, name: 'a'.repeat(50) });
    expect(server?.id).toHaveLength(32);
  });

  it('still rejects a name with nothing usable in it', () => {
    const { server, error } = validateMcpServer({ ...panelPayload, name: '!!!' });
    expect(server).toBeUndefined();
    expect(error).toMatch(/letter or digit/);
  });
});

describe('validateMcpServer — required fields', () => {
  it('requires a name', () => {
    expect(validateMcpServer({ name: '  ', command: 'npx' }).error).toMatch(/Name is required/);
  });

  it('requires a command for a stdio server', () => {
    expect(validateMcpServer({ name: 'x', transport: 'stdio' }).error).toMatch(/needs a command/);
  });

  it('requires an http(s) URL for an http server', () => {
    expect(validateMcpServer({ name: 'x', transport: 'http', url: 'ftp://n' }).error).toMatch(
      /http\(s\) URL/,
    );
    expect(
      validateMcpServer({ name: 'x', transport: 'http', url: 'https://n' }).error,
    ).toBeUndefined();
  });

  it('defaults an unknown transport to stdio', () => {
    const { server } = validateMcpServer({
      name: 'x',
      transport: 'carrier-pigeon' as never,
      command: 'npx',
    });
    expect(server?.transport).toBe('stdio');
  });

  it('defaults enabled to true but honours an explicit false', () => {
    expect(validateMcpServer({ name: 'x', command: 'npx' }).server?.enabled).toBe(true);
    expect(validateMcpServer({ name: 'x', command: 'npx', enabled: false }).server?.enabled).toBe(
      false,
    );
  });

  it('drops non-string args rather than passing them to the process', () => {
    const { server } = validateMcpServer({
      name: 'x',
      command: 'npx',
      args: ['-y', 42, null, 'pkg'] as never,
    });
    expect(server && 'args' in server ? server.args : undefined).toEqual(['-y', 'pkg']);
  });
});
