import { describe, it, expect } from 'vitest';
import { fitView, type FitPoint } from './graph-fit';

/*
The property that matters is one sentence long: after applying the returned
transform, every node is inside the canvas. Everything below is a way of
getting that wrong.
*/
const W = 800;
const H = 500;

function corners(points: FitPoint[], view: { k: number; x: number; y: number }) {
  return points.map((p) => ({
    left: p.x! * view.k + view.x - p.r * view.k,
    right: p.x! * view.k + view.x + p.r * view.k,
    top: p.y! * view.k + view.y - p.r * view.k,
    bottom: p.y! * view.k + view.y + p.r * view.k,
  }));
}

function allInside(points: FitPoint[], view: { k: number; x: number; y: number }) {
  return corners(points, view).every(
    (c) => c.left >= -0.001 && c.top >= -0.001 && c.right <= W + 0.001 && c.bottom <= H + 0.001,
  );
}

describe('fitView', () => {
  it('brings a graph that spilled far outside the canvas back into it', () => {
    // The reported case: the force layout put nodes where nothing could reach them.
    const points: FitPoint[] = [
      { x: -1200, y: -800, r: 6 },
      { x: 2400, y: 1900, r: 10 },
      { x: 40, y: 55, r: 4 },
    ];
    const view = fitView(points, W, H)!;
    expect(view).not.toBeNull();
    expect(allInside(points, view)).toBe(true);
  });

  it('keeps the requested padding away from the edges', () => {
    const points: FitPoint[] = [
      { x: 0, y: 0, r: 5 },
      { x: 600, y: 300, r: 5 },
    ];
    const view = fitView(points, W, H, { padding: 40 })!;
    for (const c of corners(points, view)) {
      expect(c.left).toBeGreaterThanOrEqual(40 - 0.001);
      expect(c.top).toBeGreaterThanOrEqual(40 - 0.001);
      expect(c.right).toBeLessThanOrEqual(W - 40 + 0.001);
      expect(c.bottom).toBeLessThanOrEqual(H - 40 + 0.001);
    }
  });

  /**
   * Two facts blown up to fill an 800px canvas look like an error, not like
   * help — so the fit zooms out freely and in only so far.
   */
  it('does not magnify a tiny graph past the cap', () => {
    const view = fitView([{ x: 10, y: 10, r: 4 }], W, H, { maxScale: 3 })!;
    expect(view.k).toBe(3);
    // …and still centres it.
    expect(10 * view.k + view.x).toBeCloseTo(W / 2);
    expect(10 * view.k + view.y).toBeCloseTo(H / 2);
  });

  it('is limited by the tighter axis, not the looser one', () => {
    // Wide and flat: the width decides, and the height must not force a
    // scale that pushes the sides out of frame.
    const points: FitPoint[] = [
      { x: 0, y: 240, r: 5 },
      { x: 4000, y: 260, r: 5 },
    ];
    const view = fitView(points, W, H)!;
    expect(allInside(points, view)).toBe(true);
  });

  it('centres the graph rather than pinning it to a corner', () => {
    const points: FitPoint[] = [
      { x: 100, y: 100, r: 5 },
      { x: 300, y: 200, r: 5 },
    ];
    const view = fitView(points, W, H)!;
    const cx = ((100 + 300) / 2) * view.k + view.x;
    const cy = ((100 + 200) / 2) * view.k + view.y;
    expect(cx).toBeCloseTo(W / 2);
    expect(cy).toBeCloseTo(H / 2);
  });

  // Before the simulation has placed anything, framing "nothing" would throw
  // the view at NaN and leave a blank canvas with no way back.
  it('leaves the view alone when nothing has a position yet', () => {
    expect(fitView([], W, H)).toBeNull();
    expect(fitView([{ x: null, y: null, r: 5 }], W, H)).toBeNull();
    expect(fitView([{ x: NaN, y: 3, r: 5 }], W, H)).toBeNull();
  });

  it('survives a canvas smaller than its own padding', () => {
    const view = fitView([{ x: 0, y: 0, r: 5 }], 20, 20, { padding: 28 })!;
    expect(Number.isFinite(view.k)).toBe(true);
    expect(view.k).toBeGreaterThan(0);
  });

  it('ignores nodes that have no position while framing those that do', () => {
    const points: FitPoint[] = [
      { x: 0, y: 0, r: 5 },
      { x: null, y: null, r: 5 },
      { x: 200, y: 100, r: 5 },
    ];
    const view = fitView(points, W, H)!;
    expect(
      allInside(
        points.filter((p) => p.x != null),
        view,
      ),
    ).toBe(true);
  });
});
