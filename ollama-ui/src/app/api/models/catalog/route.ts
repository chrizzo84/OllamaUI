import { NextRequest } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';

// Node runtime damit wir lokale Datei lesen können
export const runtime = 'nodejs';

interface CatalogVariant {
  tag: string;
  size_text?: string;
  size_bytes?: number;
  context?: string | null;
  input?: string | null;
}
interface CatalogModel {
  slug: string;
  name?: string;
  pulls?: number | null;
  pulls_text?: string | null;
  capabilities?: string[];
  blurb?: string | null;
  description?: string | null;
  updated?: string | null;
  tags_count?: number | null;
  variants?: CatalogVariant[];
}
interface CatalogFile { scraped_at: string; models: CatalogModel[] }

function filterAndLimit(models: CatalogModel[], q?: string | null, limit?: number | null) {
  let out = models;
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter(
      (m) =>
        m.slug.toLowerCase().includes(needle) ||
        (m.name && m.name.toLowerCase().includes(needle)) ||
        (m.capabilities && m.capabilities.some((c) => c.toLowerCase().includes(needle))),
    );
  }
  if (limit && limit > 0) out = out.slice(0, limit);
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const q = searchParams.get('q');
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Number(limitParam) : undefined;
    const filePath = path.join(process.cwd(), 'models.json');
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as CatalogFile;
    const models = filterAndLimit(parsed.models, q, limit);
    return new Response(
      JSON.stringify({
        scraped_at: parsed.scraped_at,
        total: parsed.models.length,
        count: models.length,
        models,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'Failed to read catalog';
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
