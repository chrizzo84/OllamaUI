import { describe, it, expect } from 'vitest';
import { extractDocumentText } from './document-extract';

const buf = (s: string) => Buffer.from(s, 'utf-8');

describe('extractDocumentText', () => {
  it('reads a plain text file by MIME type', async () => {
    expect(await extractDocumentText(buf('hello'), 'note', 'text/plain')).toBe('hello');
  });

  it('reads application/json by MIME type', async () => {
    expect(await extractDocumentText(buf('{"a":1}'), 'blob', 'application/json')).toBe('{"a":1}');
  });

  it.each([
    'notes.md',
    'data.csv',
    'config.yaml',
    'script.py',
    'main.rs',
    'index.tsx',
    'query.sql',
    'Dockerfile.sh',
  ])('reads %s by extension even with an unhelpful MIME type', async (name) => {
    expect(await extractDocumentText(buf('content'), name, 'application/octet-stream')).toBe(
      'content',
    );
  });

  it('matches extensions case-insensitively', async () => {
    expect(await extractDocumentText(buf('x'), 'README.MD', undefined)).toBe('x');
  });

  it('trims surrounding whitespace', async () => {
    expect(await extractDocumentText(buf('  hi  \n'), 'a.txt', undefined)).toBe('hi');
  });

  it('rejects an unsupported binary type with an actionable message', async () => {
    await expect(extractDocumentText(buf('...'), 'photo.heic', 'image/heic')).rejects.toThrow(
      /only PDF and plain-text-like files/,
    );
  });

  it('names the offending file in the rejection', async () => {
    await expect(extractDocumentText(buf('x'), 'archive.zip', undefined)).rejects.toThrow(
      /archive\.zip/,
    );
  });

  it('rejects a file with no extractable text', async () => {
    await expect(extractDocumentText(buf('   \n  '), 'empty.txt', undefined)).rejects.toThrow(
      /no extractable text/,
    );
  });

  it('truncates a very long document and says so', async () => {
    const out = await extractDocumentText(buf('x'.repeat(25_000)), 'big.txt', undefined);
    expect(out.length).toBeLessThan(21_000);
    expect(out).toContain('[... truncated, document was 25000 characters]');
  });

  it('does not truncate a document that is exactly at the cap', async () => {
    const out = await extractDocumentText(buf('x'.repeat(20_000)), 'exact.txt', undefined);
    expect(out).not.toContain('truncated');
  });
});
