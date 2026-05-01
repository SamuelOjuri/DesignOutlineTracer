import { Point } from "@/types/roof";

/**
 * Find the closest edge of any outline to a given point.
 * Returns null if no edge is within the distance threshold.
 */
export function findClosestVertex(
  x: number,
  y: number,
  outlines: Point[][],
  threshold: number
): { outlineIndex: number; vertexIndex: number; distance: number } | null {
  let best: { outlineIndex: number; vertexIndex: number; distance: number } | null = null;
  for (let oi = 0; oi < outlines.length; oi++) {
    const outline = outlines[oi];
    for (let vi = 0; vi < outline.length; vi++) {
      const dist = Math.hypot(x - outline[vi].x, y - outline[vi].y);
      if (dist < threshold && (!best || dist < best.distance)) {
        best = { outlineIndex: oi, vertexIndex: vi, distance: dist };
      }
    }
  }
  return best;
}

export function findClosestEdge(
  x: number,
  y: number,
  outlines: Point[][],
  threshold: number
): { outlineIndex: number; edgeIndex: number; distance: number } | null {
  let best: { outlineIndex: number; edgeIndex: number; distance: number } | null = null;

  for (let oi = 0; oi < outlines.length; oi++) {
    const outline = outlines[oi];
    if (outline.length < 3) continue;
    for (let ei = 0; ei < outline.length; ei++) {
      const p1 = outline[ei];
      const p2 = outline[(ei + 1) % outline.length];
      const dist = pointToSegmentDist(x, y, p1.x, p1.y, p2.x, p2.y);
      if (dist < threshold && (!best || dist < best.distance)) {
        best = { outlineIndex: oi, edgeIndex: ei, distance: dist };
      }
    }
  }
  return best;
}

function pointToSegmentDist(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Move an edge of a polygon and adjust adjacent edges via line-line intersection.
 * Returns a new polygon with updated vertices.
 */
export function movePolygonEdge(
  polygon: Point[],
  edgeIndex: number,
  dx: number,
  dy: number
): Point[] {
  const n = polygon.length;
  if (n < 3) return [...polygon];

  const result = polygon.map(p => ({ ...p }));

  const i = edgeIndex;
  const j = (i + 1) % n;

  // Compute edge direction and normal
  const edgeDx = polygon[j].x - polygon[i].x;
  const edgeDy = polygon[j].y - polygon[i].y;
  const edgeLen = Math.hypot(edgeDx, edgeDy);
  if (edgeLen < 1e-6) return result;

  // Normal direction (perpendicular to edge)
  const nx = -edgeDy / edgeLen;
  const ny = edgeDx / edgeLen;

  // Project the mouse delta onto the normal to get perpendicular-only movement
  const projDist = dx * nx + dy * ny;
  const perpDx = nx * projDist;
  const perpDy = ny * projDist;

  // Simply translate just the two edge vertices — all other vertices stay put,
  // so adjacent edges naturally stretch/shrink to connect.
  result[i] = { x: Math.round(polygon[i].x + perpDx), y: Math.round(polygon[i].y + perpDy) };
  result[j] = { x: Math.round(polygon[j].x + perpDx), y: Math.round(polygon[j].y + perpDy) };

  return result;
}

/**
 * Line-line intersection.
 * Line 1 passes through A and B (direction A→B extended infinitely).
 * Line 2 passes through C and D (direction C→D extended infinitely).
 * Returns the intersection point, or null if lines are parallel.
 */
function lineLineIntersection(
  A: Point, B: Point,
  C: Point, D: Point
): Point | null {
  const d1x = B.x - A.x;
  const d1y = B.y - A.y;
  const d2x = D.x - C.x;
  const d2y = D.y - C.y;

  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-10) return null; // parallel

  const t = ((C.x - A.x) * d2y - (C.y - A.y) * d2x) / denom;

  return {
    x: Math.round(A.x + t * d1x),
    y: Math.round(A.y + t * d1y),
  };
}

/**
 * Rasterize a polygon into a mask using scanline fill.
 * Sets mask[y * width + x] = 1 for all pixels inside the polygon.
 */
export function rasterizePolygon(
  polygon: Point[],
  width: number,
  height: number,
  mask: Uint8Array
): void {
  if (polygon.length < 3) return;

  // Find bounding box
  let minY = height, maxY = 0;
  for (const p of polygon) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(height - 1, Math.ceil(maxY));

  const n = polygon.length;

  for (let y = minY; y <= maxY; y++) {
    // Find all x-intersections with polygon edges
    const intersections: number[] = [];
    for (let i = 0; i < n; i++) {
      const p1 = polygon[i];
      const p2 = polygon[(i + 1) % n];
      const y1 = p1.y, y2 = p2.y;

      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const x = p1.x + ((y - y1) / (y2 - y1)) * (p2.x - p1.x);
        intersections.push(x);
      }
    }

    intersections.sort((a, b) => a - b);

    // Fill between pairs
    for (let i = 0; i < intersections.length - 1; i += 2) {
      const xStart = Math.max(0, Math.ceil(intersections[i]));
      const xEnd = Math.min(width - 1, Math.floor(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        mask[y * width + x] = 1;
      }
    }
  }
}

/**
 * Rasterize multiple polygons (outlines) into a mask,
 * cutting out holes using even-odd rule.
 */
export function rasterizeOutlinesWithHoles(
  outlines: Point[][],
  holes: Point[][],
  width: number,
  height: number
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const outline of outlines) {
    rasterizePolygon(outline, width, height, mask);
  }
  // Cut out holes
  const holeMask = new Uint8Array(width * height);
  for (const hole of holes) {
    rasterizePolygon(hole, width, height, holeMask);
  }
  for (let i = 0; i < width * height; i++) {
    if (holeMask[i]) mask[i] = 0;
  }
  return mask;
}
