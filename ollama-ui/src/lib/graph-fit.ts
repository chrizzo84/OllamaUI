/**
 * Framing a force-directed graph inside its canvas.
 *
 * Extracted from the graph component because it is the arithmetic that
 * decides whether a node is reachable at all: a force layout puts things
 * where the physics wants them, which is regularly outside a fixed viewport,
 * and a graph whose nodes sit off-canvas looks like a graph that lost them.
 * Small enough to hold in your head, wrong in ways a screenshot won't show —
 * so it is a pure function with tests rather than three lines inside a draw
 * call.
 */
export interface FitPoint {
  x?: number | null;
  y?: number | null;
  /** Radius, so a big node at the edge is framed by its rim, not its centre. */
  r: number;
}

export interface ViewTransform {
  /** Scale. Screen = world * k + offset. */
  k: number;
  x: number;
  y: number;
}

/**
 * The largest scale at which every point fits, never bigger than `maxScale` —
 * a graph of two nodes magnified to fill a canvas reads as broken, not as
 * helpful.
 */
export function fitView(
  points: FitPoint[],
  width: number,
  height: number,
  options: { padding?: number; maxScale?: number } = {},
): ViewTransform | null {
  const padding = options.padding ?? 28;
  const maxScale = options.maxScale ?? 3;
  const placed = points.filter(
    (p) =>
      typeof p.x === 'number' &&
      typeof p.y === 'number' &&
      Number.isFinite(p.x) &&
      Number.isFinite(p.y),
  );
  // Nothing placed yet: leave the view alone rather than centring on nothing.
  if (!placed.length) return null;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of placed) {
    minX = Math.min(minX, p.x! - p.r);
    minY = Math.min(minY, p.y! - p.r);
    maxX = Math.max(maxX, p.x! + p.r);
    maxY = Math.max(maxY, p.y! + p.r);
  }

  // A viewport smaller than its own padding would give a negative scale;
  // clamped so the result is always something that can be drawn.
  const usableW = Math.max(1, width - padding * 2);
  const usableH = Math.max(1, height - padding * 2);
  const spanW = Math.max(1, maxX - minX);
  const spanH = Math.max(1, maxY - minY);
  const k = Math.min(maxScale, usableW / spanW, usableH / spanH);

  return {
    k,
    x: width / 2 - ((minX + maxX) / 2) * k,
    y: height / 2 - ((minY + maxY) / 2) * k,
  };
}
