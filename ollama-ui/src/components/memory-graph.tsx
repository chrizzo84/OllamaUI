'use client';
/**
 * The knowledge graph, drawn.
 *
 * Obsidian's graph view is the screenshot everyone shows and the tab nobody
 * opens twice: past a few hundred nodes it's a hairball you can't read
 * anything out of. The situation here is different in the one way that
 * matters — those notes are written by a person, who knows what is in them,
 * while every fact here was written by a model. So this is not decoration,
 * it is the inspection surface: what does the machine believe, what did it
 * replace, and where does it disagree with itself.
 *
 * Three decisions follow from that:
 *
 *  - **Neighbourhoods, not everything.** Clicking a node re-centres the view
 *    on it (the server walks a couple of hops from there). The overview is
 *    capped and ranked by connectedness and actual use.
 *  - **Edges carry the meaning.** `contradicts` is drawn in warning colour
 *    and dashed, `supersedes` as a faded arrow into history, `about` as the
 *    plain structural link. The kind of line matters more here than the
 *    position of the dots.
 *  - **Size is earned.** A fact's radius comes from how often retrieval
 *    actually used it, so what the model really leans on is visible at a
 *    glance — and so is the dead weight.
 *
 * Canvas rather than SVG: a few hundred nodes with per-frame physics is
 * exactly where SVG's per-element overhead starts dropping frames.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

export interface GraphNode {
  id: string;
  kind: 'memory' | 'entity';
  label: string;
  type?: string;
  status?: string;
  useCount?: number;
  pinned?: boolean;
  degree?: number;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: 'about' | 'supersedes' | 'contradicts' | 'derived_from';
  resolved: boolean;
}

interface SimNode extends SimulationNodeDatum, GraphNode {
  r: number;
}
type SimLink = SimulationLinkDatum<SimNode> & { kind: GraphEdge['kind']; resolved: boolean };

const EDGE_STYLE: Record<string, { colour: string; dash: number[]; width: number }> = {
  about: { colour: 'rgba(255,255,255,0.18)', dash: [], width: 1 },
  supersedes: { colour: 'rgba(255,255,255,0.10)', dash: [3, 3], width: 1 },
  contradicts: { colour: 'rgba(251,191,36,0.75)', dash: [5, 3], width: 1.8 },
  derived_from: { colour: 'rgba(255,255,255,0.08)', dash: [2, 4], width: 1 },
};

const TYPE_COLOUR: Record<string, string> = {
  identity: '#a78bfa',
  preference: '#60a5fa',
  state: '#34d399',
  episodic: '#f472b6',
  procedural: '#fbbf24',
  unsorted: '#94a3b8',
};

function nodeRadius(n: GraphNode): number {
  if (n.kind === 'entity') return 5 + Math.min(9, (n.degree ?? 0) * 1.6);
  // Use count is the honest measure of a fact's worth: it says how often the
  // retrieval actually reached for it, not how recently it was written.
  return 4 + Math.min(8, Math.sqrt(n.useCount ?? 0) * 2.2) + (n.pinned ? 2 : 0);
}

export function MemoryGraph({
  nodes,
  edges,
  focus,
  onFocus,
  onSelect,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  focus?: string;
  onFocus: (id: string | undefined) => void;
  onSelect: (node: GraphNode | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const hoveredRef = useRef<string | null>(null);
  const [size, setSize] = useState({ w: 800, h: 520 });

  useEffect(() => {
    hoveredRef.current = hovered;
  }, [hovered]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: Math.max(360, Math.min(640, el.clientWidth * 0.55)) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, size.w, size.h);

    const hoveredId = hoveredRef.current;
    const neighbours = new Set<string>();
    if (hoveredId) {
      for (const l of linksRef.current) {
        const s = (l.source as SimNode).id;
        const t = (l.target as SimNode).id;
        if (s === hoveredId) neighbours.add(t);
        if (t === hoveredId) neighbours.add(s);
      }
    }

    for (const l of linksRef.current) {
      const s = l.source as SimNode;
      const t = l.target as SimNode;
      if (s.x == null || t.x == null) continue;
      const style = EDGE_STYLE[l.kind] ?? EDGE_STYLE.about;
      const dimmed = hoveredId && s.id !== hoveredId && t.id !== hoveredId ? 0.25 : 1;
      ctx.save();
      ctx.globalAlpha = dimmed * (l.kind === 'contradicts' && l.resolved ? 0.3 : 1);
      ctx.strokeStyle = style.colour;
      ctx.lineWidth = style.width;
      ctx.setLineDash(style.dash);
      ctx.beginPath();
      ctx.moveTo(s.x!, s.y!);
      ctx.lineTo(t.x!, t.y!);
      ctx.stroke();
      ctx.restore();
    }

    for (const n of nodesRef.current) {
      if (n.x == null) continue;
      const isHovered = n.id === hoveredId;
      const isFocus = n.id === focus;
      const dimmed = hoveredId && !isHovered && !neighbours.has(n.id) ? 0.3 : 1;
      ctx.save();
      ctx.globalAlpha = dimmed * (n.status && n.status !== 'active' ? 0.45 : 1);
      ctx.beginPath();
      ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
      if (n.kind === 'entity') {
        ctx.fillStyle = '#e2e8f0';
      } else {
        ctx.fillStyle = TYPE_COLOUR[n.type ?? 'unsorted'] ?? TYPE_COLOUR.unsorted;
      }
      ctx.fill();
      if (isFocus || isHovered) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.stroke();
      }
      // Entities are the landmarks people navigate by, so they keep their
      // label; facts would turn the canvas into a wall of text, and show
      // theirs on hover instead.
      if (n.kind === 'entity' || isHovered) {
        const label = n.label.length > 46 ? `${n.label.slice(0, 45)}…` : n.label;
        ctx.globalAlpha = dimmed;
        ctx.font = isHovered ? '600 12px system-ui, sans-serif' : '11px system-ui, sans-serif';
        ctx.fillStyle = isHovered ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'center';
        ctx.fillText(label, n.x!, n.y! - n.r - 5);
      }
      ctx.restore();
    }
    ctx.restore();
  }, [size.w, size.h, focus]);

  // Rebuild the simulation when the data changes. Positions of nodes that
  // survive the change are carried over, so re-centring the view moves the
  // picture rather than reshuffling it entirely.
  useEffect(() => {
    const previous = new Map(nodesRef.current.map((n) => [n.id, n]));
    const simNodes: SimNode[] = nodes.map((n) => {
      const old = previous.get(n.id);
      return {
        ...n,
        r: nodeRadius(n),
        x: old?.x ?? size.w / 2 + (Math.random() - 0.5) * 120,
        y: old?.y ?? size.h / 2 + (Math.random() - 0.5) * 120,
      };
    });
    const byId = new Map(simNodes.map((n) => [n.id, n]));
    const simLinks: SimLink[] = edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => ({
        source: byId.get(e.source)!,
        target: byId.get(e.target)!,
        kind: e.kind,
        resolved: e.resolved,
      }));
    nodesRef.current = simNodes;
    linksRef.current = simLinks;

    simRef.current?.stop();
    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance((l) => (l.kind === 'about' ? 70 : 45))
          .strength(0.35),
      )
      .force('charge', forceManyBody<SimNode>().strength(-180).distanceMax(400))
      .force('center', forceCenter(size.w / 2, size.h / 2))
      .force(
        'collide',
        forceCollide<SimNode>().radius((d) => d.r + 14),
      )
      /*
      Settle fast and then stop. A simulation that keeps drifting looks alive
      but makes the graph unusable: by the time you have aimed at a node it
      has moved, and every click misses. alphaMin ends it after roughly a
      second, and the higher velocityDecay keeps it from swinging past its
      resting position on the way there.
      */
      .alpha(0.9)
      .alphaDecay(0.06)
      .alphaMin(0.02)
      .velocityDecay(0.45)
      .on('tick', draw);
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [nodes, edges, size.w, size.h, draw]);

  useEffect(() => {
    draw();
  }, [draw]);

  function nodeAt(clientX: number, clientY: number): SimNode | null {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    let best: SimNode | null = null;
    let bestDist = Infinity;
    for (const n of nodesRef.current) {
      if (n.x == null || n.y == null) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < n.r + 6 && d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  const legend = useMemo(
    () => [
      ['identity', 'Über dich'],
      ['preference', 'Arbeitsweise'],
      ['state', 'Aktueller Stand'],
      ['episodic', 'Ereignisse'],
      ['unsorted', 'Unsortiert'],
    ],
    [],
  );

  return (
    <div ref={wrapRef} className="flex flex-col gap-2">
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-black/30">
        <canvas
          ref={canvasRef}
          width={size.w * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)}
          height={size.h * (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)}
          style={{ width: size.w, height: size.h }}
          className="block cursor-pointer"
          onMouseMove={(e) => {
            const n = nodeAt(e.clientX, e.clientY);
            if (n?.id !== hovered) {
              setHovered(n?.id ?? null);
              hoveredRef.current = n?.id ?? null;
              draw();
            }
          }}
          onMouseLeave={() => {
            setHovered(null);
            hoveredRef.current = null;
            draw();
          }}
          onClick={(e) => {
            const n = nodeAt(e.clientX, e.clientY);
            onSelect(n ?? null);
            if (n) onFocus(n.id);
          }}
        />
        {focus && (
          <button
            onClick={() => {
              onFocus(undefined);
              onSelect(null);
            }}
            className="absolute right-3 top-3 rounded-lg border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] text-white/70 hover:text-white"
          >
            Ganze Übersicht
          </button>
        )}
        {nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-white/40">
            Noch nichts verknüpft — Fakten mit [[Klammern]] bauen den Graphen auf.
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-white/35">
        {legend.map(([type, label]) => (
          <span key={type} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: TYPE_COLOUR[type] }}
            />
            {label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-slate-200" />
          Entität
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-px w-4 bg-amber-400" />
          widerspricht
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-px w-4 bg-white/20" />
          ersetzt / handelt von
        </span>
        <span className="ml-auto">Klick zentriert · Größe = wie oft benutzt</span>
      </div>
    </div>
  );
}
