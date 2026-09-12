/**
 * The knowledge graph as nodes and edges, for the Memory page's graph view.
 *
 * Neighbourhood-first: `?focus=` centres on one node and walks `?hops=`
 * outward, because the questions worth asking of a graph like this are local
 * ones — what does this connect to, what disagrees with what, what do we
 * know about this thing. Without a focus it returns a capped overview
 * ordered by how connected and how used things are, so the first look shows
 * the shape of the store rather than whatever was written last.
 */
import { NextRequest } from 'next/server';
import { buildGraph, listEntitiesWithCounts } from '@/lib/db';

export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const focus = searchParams.get('focus') ?? undefined;
  const hops = Number(searchParams.get('hops') ?? '2');
  const limit = Number(searchParams.get('limit') ?? '250');
  const graph = buildGraph({
    focus,
    hops: Number.isFinite(hops) ? hops : 2,
    limit: Number.isFinite(limit) ? Math.min(1000, Math.max(10, limit)) : 250,
    includeHistory: searchParams.get('history') === '1',
  });
  return Response.json({
    ...graph,
    entities: listEntitiesWithCounts().map((e) => ({
      id: e.id,
      label: e.label,
      memoryCount: e.memoryCount,
    })),
  });
}
