import { Point } from "@/types/roof";
import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";

const signedArea = (points: Point[]) => points.reduce((area, point, index) => {
  const next = points[(index + 1) % points.length];
  return area + point.x * next.y - next.x * point.y;
}, 0) / 2;

function segmentsTouch(start: Point, end: Point, otherStart: Point, otherEnd: Point): boolean {
  const cross = (first: Point, second: Point, third: Point) =>
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const onSegment = (point: Point, first: Point, second: Point) =>
    point.x >= Math.min(first.x, second.x) && point.x <= Math.max(first.x, second.x)
    && point.y >= Math.min(first.y, second.y) && point.y <= Math.max(first.y, second.y);
  const first = cross(start, end, otherStart), second = cross(start, end, otherEnd);
  const third = cross(otherStart, otherEnd, start), fourth = cross(otherStart, otherEnd, end);
  return (first * second < 0 && third * fourth < 0)
    || (first === 0 && onSegment(otherStart, start, end))
    || (second === 0 && onSegment(otherEnd, start, end))
    || (third === 0 && onSegment(start, otherStart, otherEnd))
    || (fourth === 0 && onSegment(end, otherStart, otherEnd));
}

function boundariesTouch(first: Point[], second: Point[]): boolean {
  return first.some((point, index) => second.some((other, otherIndex) =>
    segmentsTouch(point, first[(index + 1) % first.length], other, second[(otherIndex + 1) % second.length])));
}

const asPolygon = (points: Point[]): Polygon => [points.map(({ x, y }) => [x, y])];
const toPoints = (ring: number[][]): Point[] => {
  const first = ring[0], last = ring[ring.length - 1];
  const open = first && last && first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
  return open.map(([x, y]) => ({ x, y }));
};

interface BoundaryDefect { kind: "duplicate" | "overlap" | "touch" | "cross"; points: Point[] }

function boundaryDefects(points: Point[]): BoundaryDefect[] {
  const defects: BoundaryDefect[] = [];
  const pointKey = (point: Point) => `${point.x},${point.y}`;
  const seen = new Set<string>();
  for (const point of points) {
    const key = pointKey(point);
    if (seen.has(key)) defects.push({ kind: "duplicate", points: [point] });
    seen.add(key);
  }
  for (let edgeIndex = 0; edgeIndex < points.length; edgeIndex++) {
    const endIndex = (edgeIndex + 1) % points.length;
    const start = points[edgeIndex], end = points[endIndex];
    for (let otherIndex = edgeIndex + 1; otherIndex < points.length; otherIndex++) {
      const otherEndIndex = (otherIndex + 1) % points.length;
      const otherStart = points[otherIndex], otherEnd = points[otherEndIndex];
      if (!segmentsTouch(start, end, otherStart, otherEnd)) continue;
      const shared = [start, end, otherStart, otherEnd].filter(point =>
        segmentsTouch(start, end, point, point) && segmentsTouch(otherStart, otherEnd, point, point));
      const sharedPoints = [...new Map(shared.map(point => [pointKey(point), point])).values()];
      const adjacent = endIndex === otherIndex || otherEndIndex === edgeIndex;
      if (sharedPoints.length > 1) defects.push({ kind: "overlap", points: sharedPoints });
      else if (!adjacent && sharedPoints.length) defects.push({ kind: "touch", points: sharedPoints });
      else if (!adjacent) {
        const deltaX = end.x - start.x, deltaY = end.y - start.y;
        const otherDeltaX = otherEnd.x - otherStart.x, otherDeltaY = otherEnd.y - otherStart.y;
        const distance = ((otherStart.x - start.x) * otherDeltaY - (otherStart.y - start.y) * otherDeltaX)
          / (deltaX * otherDeltaY - deltaY * otherDeltaX);
        defects.push({ kind: "cross", points: [{ x: start.x + distance * deltaX, y: start.y + distance * deltaY }] });
      }
    }
  }
  return defects;
}

export interface OutlineEditResult {
  outlines: Point[][];
  holes: Point[][];
  editedOutlineIndex?: number;
  error: string | null;
  repaired: boolean;
}

export function prepareOutlineEdit(outlines: Point[][], outlineIndex: number, candidate: Point[], holes: Point[][]): OutlineEditResult {
  const reject = (reason: string): OutlineEditResult => ({ outlines, holes, error: `Edit blocked: ${reason}`, repaired: false });
  const original = outlines[outlineIndex];
  if (!original || candidate.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return reject("the boundary contains invalid coordinates.");
  }
  if (new Set(candidate.map(point => `${point.x},${point.y}`)).size < 3 || Math.abs(signedArea(candidate)) < 1) {
    return reject("the roof must retain at least three distinct vertices and a non-zero area.");
  }
  const previousDefects = boundaryDefects(original);
  const defects = boundaryDefects(candidate);
  const matched = new Set<number>();
  for (const defect of defects) {
    const inherited = previousDefects.findIndex((previous, index) => {
      if (matched.has(index) || previous.kind !== defect.kind) return false;
      if (defect.kind === "overlap") {
        return defect.points.every(point => segmentsTouch(previous.points[0], previous.points[1], point, point));
      }
      return Math.hypot(defect.points[0].x - previous.points[0].x, defect.points[0].y - previous.points[0].y) < 1e-8;
    });
    if (inherited >= 0) { matched.add(inherited); continue; }
    if (defect.kind === "duplicate") return reject("two vertices would occupy the same position. Merge adjacent vertices instead.");
    return reject(previousDefects.length
      ? "this move creates or worsens a crossing or retraced edge in an already defective boundary."
      : "this move would make boundary edges cross, touch or retrace each other.");
  }
  if (signedArea(candidate) * signedArea(original) <= 0 && !previousDefects.length) {
    return reject("this move would invert the roof boundary.");
  }
  try {
    const scope = defects.length ? polygonClipping.union(asPolygon(candidate)) : [asPolygon(candidate)];
    return reconcileOutlineScope(outlines, outlineIndex, scope, holes, {
      repaired: previousDefects.length > 0, candidate: defects.length ? undefined : candidate,
    });
  } catch {
    return reject("the existing boundary or cutouts could not be processed. Undo the last edit or reselect this area.");
  }
}

/** Reconcile cutouts and validate the rebuilt boundaries before committing any geometry. */
function reconcileOutlineScope(
  outlines: Point[][], outlineIndex: number, scope: MultiPolygon, holes: Point[][],
  options: { repaired: boolean; candidate?: Point[]; allowRemoval?: boolean },
): OutlineEditResult {
  const { repaired, candidate, allowRemoval = false } = options;
  const reject = (reason: string): OutlineEditResult => ({ outlines, holes, error: `Edit blocked: ${reason}`, repaired: false });
  const original = outlines[outlineIndex];
  const boundaries = scope.map(polygon => toPoints(polygon[0]));
  for (const [index, other] of outlines.entries()) {
    if (index === outlineIndex) continue;
    if (boundaries.some(boundary => boundariesTouch(boundary, other)) || polygonClipping.intersection(scope, asPolygon(other)).length) {
      return reject(`the boundary would touch or overlap roof area ${index + 1}.`);
    }
  }
  const affected = new Set<number>();
  const excluded = new Set<number>();
  let rebuild = !candidate;
  for (const [index, hole] of holes.entries()) {
    const cutout = asPolygon(hole);
    if (!polygonClipping.intersection(asPolygon(original), cutout).length) continue;
    affected.add(index);
    if (!polygonClipping.intersection(scope, cutout).length) excluded.add(index);
    else if (boundaries.some(boundary => boundariesTouch(boundary, hole)) || polygonClipping.difference(cutout, scope).length) rebuild = true;
  }
  if (!rebuild) {
    return { outlines: outlines.map((outline, index) => index === outlineIndex ? candidate : outline),
      holes: holes.filter((_, index) => !excluded.has(index)), editedOutlineIndex: outlineIndex, error: null, repaired };
  }
  const cuts = [...affected].map(index => asPolygon(holes[index]));
  const result = cuts.length ? polygonClipping.difference(scope, ...cuts) : scope;
  if (!result.length && (!allowRemoval || outlines.length === 1)) {
    return reject("no insulation area would remain after trimming the boundary and subtracting the cutouts.");
  }
  const replacements = result.map(polygon => {
    const points = toPoints(polygon[0]);
    return signedArea(points) * signedArea(original) < 0 ? points.reverse() : points;
  });
  if (replacements.some(points => boundaryDefects(points).length || Math.abs(signedArea(points)) < 1)) {
    return reject("the boundary could not be rebuilt into separate, non-crossing outlines.");
  }
  if (replacements.some((points, index) => replacements.slice(index + 1).some(other => boundariesTouch(points, other)))) {
    return reject("the remaining roof areas would touch. Move the edge slightly farther to separate them.");
  }
  const generatedHoles = result.flatMap(polygon => polygon.slice(1).map(toPoints));
  const nextHoles = holes.flatMap((hole, index) => {
    if (!affected.has(index)) return [hole];
    const match = generatedHoles.findIndex(generated =>
      !polygonClipping.difference(asPolygon(hole), asPolygon(generated)).length
      && !polygonClipping.difference(asPolygon(generated), asPolygon(hole)).length);
    if (match < 0) return [];
    generatedHoles.splice(match, 1);
    return [hole];
  });
  return {
    outlines: outlines.flatMap((outline, index) => index === outlineIndex ? replacements : [outline]),
    holes: [...nextHoles, ...generatedHoles],
    editedOutlineIndex: replacements.length === 1 ? outlineIndex : undefined,
    error: null, repaired,
  };
}

/**
 * Inward edge drags subtract the swept area from the original roof. Sweeping the
 * two incident edges as well handles sloping neighbours without leaving spikes.
 * Work from the original ring, never a self-crossing moved candidate: increasing
 * an inward drag can only remove area, even after passing a return or cutout.
 * Outward drags retain the ordinary crossing and collision checks.
 */
export function prepareEdgeEdit(
  outlines: Point[][], outlineIndex: number, edgeIndex: number, dx: number, dy: number, holes: Point[][],
): OutlineEditResult {
  const reject = (reason: string): OutlineEditResult => ({ outlines, holes, error: `Edit blocked: ${reason}`, repaired: false });
  const original = outlines[outlineIndex];
  if (!original || !Number.isInteger(edgeIndex) || !original[edgeIndex] || !Number.isFinite(dx) || !Number.isFinite(dy)
    || original.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return reject("the boundary contains invalid coordinates.");
  }
  const candidate = movePolygonEdge(original, edgeIndex, dx, dy);
  const nextIndex = (edgeIndex + 1) % original.length;
  const start = original[edgeIndex], end = original[nextIndex];
  const movedStart = candidate[edgeIndex], movedEnd = candidate[nextIndex];
  const inward = ((end.x - start.x) * (movedStart.y - start.y)
    - (end.y - start.y) * (movedStart.x - start.x)) * Math.sign(signedArea(original));
  if (inward <= 0) return prepareOutlineEdit(outlines, outlineIndex, candidate, holes);

  try {
    const previous = original[(edgeIndex + original.length - 1) % original.length];
    const following = original[(nextIndex + 1) % original.length];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const tangent = { x: (end.x - start.x) / length, y: (end.y - start.y) / length };
    const winding = Math.sign(signedArea(original));
    const depth = (point: Point) => ((point.y - start.y) * tangent.x - (point.x - start.x) * tangent.y) * winding;
    const distance = depth(movedStart);
    let first = 0, last = length;
    // Once the edge passes a sloping neighbour's endpoint, include that tip in
    // the cut. Otherwise an obsolete triangular spike can remain above the edge.
    for (const point of [previous, following]) {
      if (depth(point) <= 0 || depth(point) > distance) continue;
      const along = (point.x - start.x) * tangent.x + (point.y - start.y) * tangent.y;
      first = Math.min(first, along);
      last = Math.max(last, along);
    }
    const alongEdge = (point: Point, amount: number): Point => ({ x: point.x + tangent.x * amount, y: point.y + tangent.y * amount });
    const sweeps = [
      [alongEdge(start, first), alongEdge(end, last - length), alongEdge(movedEnd, last - length), alongEdge(movedStart, first)],
      [previous, start, movedStart],
      [end, following, movedEnd],
    ].filter(points => Math.abs(signedArea(points)) > 1e-8).map(asPolygon);
    const scope = polygonClipping.difference(asPolygon(original), ...sweeps);
    // Keep the existing vertex order for ordinary moves where the translated
    // ring already represents exactly the trimmed area (edge indices matter).
    const candidateArea = signedArea(candidate);
    const keepCandidate = scope.length === 1 && scope[0].length === 1
      && Math.abs(candidateArea) >= 1 && candidateArea * signedArea(original) > 0
      && !boundaryDefects(candidate).length
      && !polygonClipping.difference(asPolygon(candidate), scope).length
      && !polygonClipping.difference(scope, asPolygon(candidate)).length;
    // Preserve every disconnected part. A later inward drag may remove a part
    // completely, provided another roof area remains in the selection.
    return reconcileOutlineScope(outlines, outlineIndex, scope, holes, {
      repaired: boundaryDefects(original).length > 0, candidate: keepCandidate ? candidate : undefined, allowRemoval: true,
    });
  } catch {
    return reject("the existing boundary or cutouts could not be processed. Undo the last edit or reselect this area.");
  }
}

export function isValidOutlineEdit(outlines: Point[][], outlineIndex: number, candidate: Point[], holes: Point[][]): boolean {
  return prepareOutlineEdit(outlines, outlineIndex, candidate, holes).error === null;
}

export function findVertexMergeTarget(polygon: Point[], vertexIndex: number, position: Point, threshold: number): number | null {
  if (polygon.length <= 3) return null;
  const neighbours = [(vertexIndex + polygon.length - 1) % polygon.length, (vertexIndex + 1) % polygon.length];
  let target: number | null = null;
  let closest = threshold;
  for (const index of neighbours) {
    const distance = Math.hypot(position.x - polygon[index].x, position.y - polygon[index].y);
    if (distance <= closest) { target = index; closest = distance; }
  }
  return target;
}

export function mergePolygonVertex(polygon: Point[], vertexIndex: number, targetIndex: number): Point[] | null {
  if (polygon.length <= 3 || !polygon[vertexIndex] || !polygon[targetIndex]) return null;
  const separation = Math.abs(vertexIndex - targetIndex);
  if (separation !== 1 && separation !== polygon.length - 1) return null;
  return polygon.filter((_, index) => index !== vertexIndex).map(point => ({ ...point }));
}

export function straightenPolygonSide(polygon: Point[], edgeIndex: number): Point[] | null {
  if (polygon.length < 3 || !polygon[edgeIndex]) return null;
  const next = polygon[(edgeIndex + 1) % polygon.length];
  const horizontal = Math.abs(next.x - polygon[edgeIndex].x) >= Math.abs(next.y - polygon[edgeIndex].y);
  const axis = horizontal ? "x" : "y";
  const alignedAxis = horizontal ? "y" : "x";
  const direction = Math.sign(next[axis] - polygon[edgeIndex][axis]);
  const belongsToSide = (index: number) => {
    const start = polygon[index], end = polygon[(index + 1) % polygon.length];
    const length = end[axis] - start[axis];
    return Math.sign(length) === direction && length !== 0
      && Math.abs(end[alignedAxis] - start[alignedAxis]) <= Math.max(2, Math.abs(length) * Math.tan(Math.PI / 12));
  };
  if (!belongsToSide(edgeIndex)) return null;
  let first = edgeIndex, last = edgeIndex;
  for (let count = 0; count < polygon.length - 1; count++) {
    const previous = (first + polygon.length - 1) % polygon.length;
    if (!belongsToSide(previous)) break;
    first = previous;
  }
  for (let count = 0; count < polygon.length - 1; count++) {
    const following = (last + 1) % polygon.length;
    if (!belongsToSide(following) || following === first) break;
    last = following;
  }
  const endIndex = (last + 1) % polygon.length;
  const aligned = Math.round((polygon[first][alignedAxis] + polygon[endIndex][alignedAxis]) / 2);
  const result = polygon.map(point => ({ ...point }));
  for (let index = first; ; index = (index + 1) % polygon.length) {
    result[index][alignedAxis] = aligned;
    if (index === endIndex) break;
  }
  return result;
}

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
