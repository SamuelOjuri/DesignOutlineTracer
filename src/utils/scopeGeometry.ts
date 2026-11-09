import type { PageDrawing } from "@/types/roi";
import type { Point } from "@/types/roof";

// Source-pixel arithmetic tolerance, independent of zoom and deliberately much
// smaller than any drawing feature. It only absorbs interpolation round-off.
const COLLINEAR_EPSILON = 1e-9;

/** A comparison-only ring: keep corners, duplicates and backtracks intact. */
export function withoutCollinearVertices(points: readonly Point[]): Point[] {
  const ring = [...points];
  let changed = true;
  while (changed && ring.length > 3) {
    changed = false;
    for (let index = 0; index < ring.length; index++) {
      const before = ring[(index + ring.length - 1) % ring.length], point = ring[index], after = ring[(index + 1) % ring.length];
      if (![before, point, after].every(candidate => Number.isFinite(candidate.x) && Number.isFinite(candidate.y))) continue;
      const ax = point.x - before.x, ay = point.y - before.y;
      const bx = after.x - point.x, by = after.y - point.y;
      const length = Math.hypot(after.x - before.x, after.y - before.y);
      // Strictly forward legs exclude duplicates and a return along the same line.
      if (ax * bx + ay * by <= 0 || !Number.isFinite(length) || length === 0) continue;
      if (Math.abs(ax * by - ay * bx) / length > COLLINEAR_EPSILON) continue;
      ring.splice(index, 1);
      changed = true;
      break;
    }
  }
  return ring;
}

/** Normalize only redundant edge samples; saved point arrays are never rewritten. */
export function drawingScopeGeometry(drawing: PageDrawing): PageDrawing {
  return { ...drawing,
    outlines: drawing.outlines.map(outline => ({ ...outline, points: withoutCollinearVertices(outline.points) })),
    holes: drawing.holes.map(hole => ({ ...hole, points: withoutCollinearVertices(hole.points) })),
  };
}

/** Keep component order and ownership/identity metadata; only edge samples are ignored. */
export function sameDrawingScope(before: PageDrawing, after: PageDrawing): boolean {
  const first = drawingScopeGeometry(before), second = drawingScopeGeometry(after);
  return JSON.stringify([first.outlines, first.holes]) === JSON.stringify([second.outlines, second.holes]);
}
