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
 *  - **You can reach every node.** A force layout puts things where the
 *    physics wants them, which is regularly outside the frame; without pan,
 *    zoom and a way to drag a node out of a clump, those nodes may as well
 *    not exist. The view also fits itself to the graph once the simulation
 *    settles, so the common case needs no interaction at all.
 *
 * Canvas rather than SVG: a few hundred nodes with per-frame physics is
 * exactly where SVG's per-element overhead starts dropping frames.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { fitView } from '@/lib/graph-fit';
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

/** The label as drawn — shared with the fit, so the two cannot disagree. */
const ENTITY_FONT = '11px system-ui, sans-serif';
function nodeLabel(n: GraphNode): string {
  return n.label.length > 46 ? `${n.label.slice(0, 45)}…` : n.label;
}

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
  /*
  The view transform, in a ref rather than in state: it changes on every
  pointer move and every wheel notch, and a re-render per frame would cost
  more than the drawing does. Nothing in the JSX depends on it.
  */
  const viewRef = useRef({ k: 1, x: 0, y: 0 });
  /*
  Whether the view still owes the new data a fit. Set when the graph changes
  and cleared the moment anyone pans, zooms or drags — a view that re-frames
  itself under a hand that is using it is worse than one that never frames
  itself at all.
  */
  const pendingFitRef = useRef(true);
  const dragRef = useRef<{
    kind: 'pan' | 'node';
    node?: SimNode;
    /** Where the pointer went down, to tell a click from a drag. */
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const [grabbing, setGrabbing] = useState(false);

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
    // Everything below is drawn in world coordinates; this is the only place
    // that knows about the view.
    const view = viewRef.current;
    ctx.translate(view.x, view.y);
    ctx.scale(view.k, view.k);

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
        const label = nodeLabel(n);
        ctx.globalAlpha = dimmed;
        ctx.font = isHovered ? '600 12px system-ui, sans-serif' : ENTITY_FONT;
        ctx.fillStyle = isHovered ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.55)';
        ctx.textAlign = 'center';
        ctx.fillText(label, n.x!, n.y! - n.r - 5);
      }
      ctx.restore();
    }
    ctx.restore();
  }, [size.w, size.h, focus]);

  /** Pointer position in the graph's own coordinates, undoing pan and zoom. */
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (clientX - (rect?.left ?? 0) - view.x) / view.k,
      y: (clientY - (rect?.top ?? 0) - view.y) / view.k,
    };
  }, []);

  /**
   * Puts a node under the pointer.
   *
   * Both the fixed position the simulation reads (`fx`/`fy`) and the drawn
   * one (`x`/`y`): d3 only copies the first into the second on its next tick,
   * so setting `fx` alone means the node follows the hand one frame late —
   * and not at all if the layout has settled and the timer has stopped, which
   * is the state a graph spends most of its life in.
   */
  function moveNode(node: SimNode, clientX: number, clientY: number) {
    const w = toWorld(clientX, clientY);
    node.fx = w.x;
    node.fy = w.y;
    node.x = w.x;
    node.y = w.y;
  }

  const nodeAt = useCallback(
    (clientX: number, clientY: number): SimNode | null => {
      const { x, y } = toWorld(clientX, clientY);
      let best: SimNode | null = null;
      let bestDist = Infinity;
      for (const n of nodesRef.current) {
        if (n.x == null || n.y == null) continue;
        const d = Math.hypot(n.x - x, n.y - y);
        // The grab margin is in screen pixels, so it stays the same size to
        // the hand however far the view is zoomed out.
        if (d < n.r + 6 / viewRef.current.k && d < bestDist) {
          best = n;
          bestDist = d;
        }
      }
      return best;
    },
    [toWorld],
  );

  /**
   * Frames the whole graph.
   *
   * This is the answer to nodes sitting outside the canvas: a force layout
   * spreads things as far as the physics wants, and with a fixed viewport
   * that regularly means part of the graph is somewhere off to the left with
   * no way to reach it. Called automatically when the simulation settles, and
   * by the button, so the default state of the view is "everything visible".
   */
  /**
   * Frames the whole graph — the answer to nodes sitting outside the canvas.
   * Runs while the layout settles and on the button; the arithmetic lives in
   * lib/graph-fit.ts, where it can be tested.
   */
  const fitToNodes = useCallback(() => {
    /*
    Entities are framed by their label, not by their dot: the name is drawn
    above the node and is often several times wider than it, so fitting the
    circles alone leaves "Musterstadt" hanging over the edge of a canvas
    that is, strictly speaking, showing every node.
    */
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) ctx.font = ENTITY_FONT;
    const points = nodesRef.current.map((n) =>
      n.kind === 'entity' && ctx
        ? { x: n.x, y: n.y, r: Math.max(n.r + 18, ctx.measureText(nodeLabel(n)).width / 2) }
        : n,
    );
    // Capped well below a magnifying glass: blowing a three-node graph up to
    // fill the canvas reads as broken, and at high zoom the labels collide
    // with everything around them.
    const view = fitView(points, size.w, size.h, { maxScale: 1.6, padding: 32 });
    if (!view) return;
    viewRef.current = view;
    draw();
  }, [size.w, size.h, draw]);

  /** Lets go of every node a hand has pinned, and lets the physics settle again. */
  function relayout() {
    const sim = simRef.current;
    if (!sim) return;
    // Asked of the simulation rather than of our own array: these are the
    // nodes the physics is actually holding, and releasing them is its job.
    for (const n of sim.nodes()) {
      n.fx = null;
      n.fy = null;
    }
    sim.alpha(0.8).restart();
  }

  /*
  Zooming, on a non-passive listener.

  React attaches wheel handlers passively, where preventDefault does nothing
  and the page scrolls away under the graph instead of zooming it. This has
  to be a native listener to be allowed to say no.
  */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const view = viewRef.current;
      const rect = canvas!.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      pendingFitRef.current = false;
      const k = Math.min(3, Math.max(0.15, view.k * Math.exp(-e.deltaY * 0.0015)));
      // Keep whatever is under the cursor under the cursor — anything else
      // feels like the graph is sliding away while you zoom.
      viewRef.current = {
        k,
        x: px - ((px - view.x) / view.k) * k,
        y: py - ((py - view.y) / view.k) * k,
      };
      draw();
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [draw]);

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
      /*
      The frame follows the layout while it spreads, rather than waiting for
      it to finish. Waiting was the obvious version and it is the fragile one:
      it hangs on a single 'end' event, and anything that keeps the simulation
      alive — or a browser that stops delivering animation frames — leaves the
      view sitting on the initial positions with half the graph outside the
      canvas, which is exactly the state this is meant to prevent. Refitting
      per tick costs one pass over the nodes we are about to draw anyway.
      */
      .on('tick', () => {
        if (pendingFitRef.current) fitToNodes();
        else draw();
      })
      .on('end', () => {
        if (pendingFitRef.current) fitToNodes();
      });
    simRef.current = sim;
    return () => {
      sim.stop();
    };
  }, [nodes, edges, size.w, size.h, draw, fitToNodes]);

  // New data (a different focus, a fact approved) earns a new frame.
  useEffect(() => {
    pendingFitRef.current = true;
  }, [nodes, edges]);

  useEffect(() => {
    draw();
  }, [draw]);

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
          className={`block touch-none ${grabbing ? 'cursor-grabbing' : 'cursor-grab'}`}
          onPointerDown={(e) => {
            const n = nodeAt(e.clientX, e.clientY);
            e.currentTarget.setPointerCapture(e.pointerId);
            pendingFitRef.current = false;
            dragRef.current = {
              kind: n ? 'node' : 'pan',
              node: n ?? undefined,
              startX: e.clientX,
              startY: e.clientY,
              moved: false,
            };
            setGrabbing(true);
            if (n) {
              // Warm the simulation so the neighbours give way while the
              // node is moved, instead of the graph staying frozen until the
              // drag ends and then jumping.
              simRef.current?.alphaTarget(0.2).restart();
              moveNode(n, e.clientX, e.clientY);
            }
          }}
          onPointerMove={(e) => {
            const drag = dragRef.current;
            if (!drag) {
              const n = nodeAt(e.clientX, e.clientY);
              if (n?.id !== hovered) {
                setHovered(n?.id ?? null);
                hoveredRef.current = n?.id ?? null;
                draw();
              }
              return;
            }
            if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) drag.moved = true;
            if (drag.kind === 'node' && drag.node) {
              moveNode(drag.node, e.clientX, e.clientY);
              draw();
            } else {
              // Panning moves the view by raw screen pixels — dividing by the
              // zoom here would make a drag cover less ground the further out
              // you are, which is the opposite of what a hand expects.
              const view = viewRef.current;
              viewRef.current = {
                ...view,
                x: view.x + e.movementX,
                y: view.y + e.movementY,
              };
              draw();
            }
          }}
          onPointerUp={() => {
            const drag = dragRef.current;
            dragRef.current = null;
            setGrabbing(false);
            if (!drag) return;
            simRef.current?.alphaTarget(0);
            /*
            A node dropped by hand stays where it was dropped (its fx/fy are
            kept). "Verschieben" that springs back the moment you let go is
            not moving anything — and "Neu anordnen" gives every pinned node
            back to the physics in one click.
            */
            if (!drag.moved) {
              // A click, not a drag: release the node it pinned on the way
              // down, so tapping a node never silently fixes it in place.
              if (drag.node) {
                drag.node.fx = null;
                drag.node.fy = null;
              }
              onSelect(drag.node ?? null);
              if (drag.node) onFocus(drag.node.id);
            }
          }}
          onPointerLeave={() => {
            if (dragRef.current) return;
            setHovered(null);
            hoveredRef.current = null;
            draw();
          }}
        />
        <div className="absolute right-3 top-3 flex items-center gap-2">
          {focus && (
            <button
              onClick={() => {
                onFocus(undefined);
                onSelect(null);
              }}
              className="rounded-lg border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] text-white/70 hover:text-white"
            >
              Ganze Übersicht
            </button>
          )}
          {nodes.length > 0 && (
            <>
              <button
                onClick={fitToNodes}
                title="Zoomt so weit heraus, dass jeder Knoten im Bild ist"
                className="rounded-lg border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] text-white/70 hover:text-white"
              >
                Alles zeigen
              </button>
              <button
                onClick={relayout}
                title="Löst alle von Hand gesetzten Knoten und lässt die Anordnung neu einschwingen"
                className="rounded-lg border border-white/15 bg-black/60 px-2.5 py-1 text-[11px] text-white/70 hover:text-white"
              >
                Neu anordnen
              </button>
            </>
          )}
        </div>
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
        <span className="ml-auto">
          Ziehen verschiebt · Scrollen zoomt · Knoten lassen sich anfassen · Klick zentriert
        </span>
      </div>
    </div>
  );
}
