import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
import { prepareOutlineEdit, type OutlineEditResult } from "./polygonAdjust";

export interface OutlineAnchor { outlineIndex: number; edgeIndex: number; t: number; point: Point }
export interface VectorSnap { point: Point; kind: "endpoint" | "intersection" | "line"; segments: VectorSegment[] }

const EPS = 1e-7;
const finite = (point: Point) => Number.isFinite(point.x) && Number.isFinite(point.y);
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const delta = (a: Point, b: Point): Point => ({ x: b.x - a.x, y: b.y - a.y });
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const at = (a: Point, b: Point, t: number): Point => t === 0 ? a : t === 1 ? b
  : { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };

function projection(point: Point, start: Point, end: Point) {
  const direction = delta(start, end), lengthSquared = dot(direction, direction);
  if (lengthSquared <= EPS * EPS) return null;
  const t = Math.max(0, Math.min(1, dot(delta(start, point), direction) / lengthSquared));
  const projected = at(start, end, t);
  return { point: projected, t, distance: distance(point, projected) };
}

/** Anchors are on finite outline segments; an exact corner belongs to its outgoing edge. */
export function findOutlineAnchor(point: Point, outlines: Point[][], tolerance: number, preferVertices = true): OutlineAnchor | null {
  if (!finite(point) || !Number.isFinite(tolerance) || tolerance < 0) return null;
  let closest = tolerance + EPS;
  let result: OutlineAnchor | null = null;
  if (preferVertices) {
    outlines.forEach((polygon, outlineIndex) => polygon.forEach((corner, edgeIndex) => {
      if (!finite(corner)) return;
      const separation = distance(point, corner);
      if (separation > closest || (result && separation >= closest - EPS)) return;
      closest = separation;
      result = { outlineIndex, edgeIndex, t: 0, point: corner };
    }));
    if (result) return result;
  }
  outlines.forEach((polygon, outlineIndex) => polygon.forEach((start, edgeIndex) => {
    const end = polygon[(edgeIndex + 1) % polygon.length];
    if (!finite(start) || !finite(end)) return;
    const candidate = projection(point, start, end);
    if (!candidate || candidate.distance > closest) return;
    // Keep the first equally close outline, rather than jumping between touching candidates.
    if (result && candidate.distance >= closest - EPS) return;
    closest = candidate.distance;
    const outgoing = candidate.t === 1 ? (edgeIndex + 1) % polygon.length : edgeIndex;
    result = { outlineIndex, edgeIndex: outgoing, t: candidate.t === 1 ? 0 : candidate.t, point: candidate.point };
  }));
  return result;
}

function segmentIntersection(first: VectorSegment, second: VectorSegment): Point | null {
  const a = delta(first.start, first.end), b = delta(second.start, second.end);
  const denominator = cross(a, b);
  if (Math.abs(denominator) <= 1e-12 * Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y)) return null;
  const offset = delta(first.start, second.start);
  const t = cross(offset, b) / denominator, u = cross(offset, a) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return at(first.start, first.end, t);
}

/** Prefer nearby real PDF corners/intersections, then fall back to a finite-segment projection. */
export function snapToVectors(point: Point, vectors: readonly VectorSegment[], tolerance: number): VectorSnap | null {
  if (!finite(point) || !Number.isFinite(tolerance) || tolerance < 0) return null;
  // Only nearby segments participate in pairwise intersections, never the full PDF operator list.
  const seen = new Set<string>();
  const nearby = vectors.flatMap(segment => {
    if (!finite(segment.start) || !finite(segment.end)
      || point.x < Math.min(segment.start.x, segment.end.x) - tolerance
      || point.x > Math.max(segment.start.x, segment.end.x) + tolerance
      || point.y < Math.min(segment.start.y, segment.end.y) - tolerance
      || point.y > Math.max(segment.start.y, segment.end.y) + tolerance) return [];
    const startKey = `${segment.start.x},${segment.start.y}`, endKey = `${segment.end.x},${segment.end.y}`;
    const key = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const projected = projection(point, segment.start, segment.end);
    return projected && projected.distance <= tolerance + EPS ? [{ segment, projected }] : [];
  });
  let node: VectorSnap | null = null;
  let nodeDistance = tolerance + EPS;
  const consider = (candidate: Point, kind: "endpoint" | "intersection", segments: VectorSegment[]) => {
    const length = distance(point, candidate);
    if (length > tolerance + EPS || (node && length >= nodeDistance - EPS)) return;
    nodeDistance = length;
    node = { point: candidate, kind, segments };
  };
  for (const { segment } of nearby) {
    consider(segment.start, "endpoint", [segment]);
    consider(segment.end, "endpoint", [segment]);
  }
  // Dense hatching can put thousands of distinct strokes under the pointer. Endpoints and line
  // projections still use all local strokes; bound pairwise work to the nearest 64 distinct ones.
  const intersections = [...nearby].sort((a, b) => a.projected.distance - b.projected.distance).slice(0, 64);
  for (let first = 0; first < intersections.length; first++) for (let second = first + 1; second < intersections.length; second++) {
    const a = intersections[first].segment, b = intersections[second].segment;
    const intersection = segmentIntersection(a, b);
    if (intersection) consider(intersection, "intersection", [a, b]);
  }
  if (node) {
    // Highlight all strokes meeting the chosen point, including a T-junction's long stroke.
    const chosen: VectorSnap = node;
    return { ...chosen, segments: nearby.filter(({ segment }) =>
      (projection(chosen.point, segment.start, segment.end)?.distance ?? Infinity) <= EPS).map(({ segment }) => segment) };
  }
  const nearest = nearby.reduce<(typeof nearby)[number] | null>((best, candidate) =>
    !best || candidate.projected.distance < best.projected.distance ? candidate : best, null);
  return nearest ? { point: nearest.projected.point, kind: "line", segments: [nearest.segment] } : null;
}

function canonicalAnchor(outlines: Point[][], anchor: OutlineAnchor): OutlineAnchor | null {
  const polygon = outlines[anchor.outlineIndex];
  if (!Number.isInteger(anchor.outlineIndex) || !polygon || polygon.length < 3
    || !Number.isInteger(anchor.edgeIndex) || !polygon[anchor.edgeIndex] || !finite(anchor.point)
    || !Number.isFinite(anchor.t) || anchor.t < 0 || anchor.t > 1) return null;
  const point = at(polygon[anchor.edgeIndex], polygon[(anchor.edgeIndex + 1) % polygon.length], anchor.t);
  if (!finite(point) || distance(point, anchor.point) > EPS) return null;
  return { ...anchor, point, edgeIndex: anchor.t === 1 ? (anchor.edgeIndex + 1) % polygon.length : anchor.edgeIndex,
    t: anchor.t === 1 ? 0 : anchor.t };
}

function forwardArc(polygon: Point[], start: OutlineAnchor, end: OutlineAnchor): Point[] {
  const first = start.edgeIndex + start.t;
  let last = end.edgeIndex + end.t;
  if (last <= first) last += polygon.length;
  const path = [start.point];
  for (let index = Math.floor(first) + 1; index < last; index++) path.push(polygon[index % polygon.length]);
  path.push(end.point);
  return path;
}

const pathLength = (path: Point[]) => path.slice(1).reduce((sum, point, index) => sum + distance(path[index], point), 0);

function paths(outlines: Point[][], first: OutlineAnchor, last: OutlineAnchor, otherPath: boolean) {
  const start = canonicalAnchor(outlines, first), end = canonicalAnchor(outlines, last);
  if (!start || !end || start.outlineIndex !== end.outlineIndex || distance(start.point, end.point) <= EPS) return null;
  const polygon = outlines[start.outlineIndex];
  const forward = forwardArc(polygon, start, end), backward = forwardArc(polygon, end, start);
  const replaceForward = (pathLength(forward) <= pathLength(backward)) !== otherPath;
  return { start, end, polygon, forward, backward, replaceForward };
}

/** The selected existing path, always ordered from the first click to the finishing click. */
export function redrawSection(outlines: Point[][], start: OutlineAnchor, end: OutlineAnchor, otherPath = false): Point[] {
  const selected = paths(outlines, start, end, otherPath);
  return selected ? selected.replaceForward ? selected.forward : [...selected.backward].reverse() : [];
}

function onSegment(point: Point, start: Point, end: Point): boolean {
  const projected = projection(point, start, end);
  return projected !== null && projected.distance <= EPS;
}

function touches(a: Point, b: Point, c: Point, d: Point): boolean {
  const ab = delta(a, b), cd = delta(c, d);
  const first = cross(ab, delta(a, c)), second = cross(ab, delta(a, d));
  const third = cross(cd, delta(c, a)), fourth = cross(cd, delta(c, b));
  return (first * second < 0 && third * fourth < 0)
    || onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b);
}

/** Replace one local boundary path while keeping its winding and all unaffected geometry. */
export function preparePolylineRedraw(outlines: Point[][], holes: Point[][], openings: Point[][],
  start: OutlineAnchor, end: OutlineAnchor, via: Point[], otherPath: boolean,
  bounds: { width: number; height: number }): OutlineEditResult {
  const reject = (reason: string): OutlineEditResult => ({ outlines, holes, error: `Redraw blocked: ${reason}`, repaired: false });
  const selected = paths(outlines, start, end, otherPath);
  if (!selected) return reject("choose two different positions on the same roof boundary.");
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0
    || [...selected.polygon, ...via].some(point => !finite(point))) return reject("the boundary contains invalid coordinates.");
  const replacement = [selected.start.point, ...via, selected.end.point];
  for (let index = 0; index < replacement.length; index++) {
    if (replacement.slice(index + 1).some(point => distance(point, replacement[index]) <= EPS)) {
      return reject("two redraw points occupy the same position. Remove the repeated point.");
    }
  }
  const candidate = selected.replaceForward
    ? [...replacement, ...selected.backward.slice(1, -1)]
    : [...replacement].reverse().concat(selected.forward.slice(1, -1));
  if (candidate.some(point => point.x < 0 || point.y < 0 || point.x > bounds.width || point.y > bounds.height)) {
    return reject("the redrawn boundary would leave the drawing page.");
  }
  // Reject crossings/retraces even when the original ring inherited an unrelated defect.
  for (let index = 0; index < candidate.length; index++) {
    const a = candidate[index], b = candidate[(index + 1) % candidate.length];
    if (distance(a, b) <= EPS) return reject("remove a repeated redraw point.");
    const c = candidate[(index + 2) % candidate.length];
    const first = delta(a, b), second = delta(b, c);
    if (Math.abs(cross(first, second)) <= EPS * Math.max(distance(a, b), distance(b, c)) && dot(first, second) < 0) {
      return reject("the redraw would retrace a boundary edge. Remove the turn-back point.");
    }
    for (let other = index + 2; other < candidate.length; other++) {
      if ((other + 1) % candidate.length === index) continue;
      if (touches(a, b, candidate[other], candidate[(other + 1) % candidate.length])) {
        return reject("the redraw would cross or touch another part of this roof boundary.");
      }
    }
  }
  // Preserve the original ring start whenever that point survived the local replacement.
  const surviving = new Set(candidate);
  const firstSurvivor = selected.polygon.find(point => surviving.has(point));
  const offset = firstSurvivor ? candidate.indexOf(firstSurvivor) : 0;
  const ordered = [...candidate.slice(offset), ...candidate.slice(0, offset)];
  const edgeRemap = selected.polygon.map(() => [] as number[]);
  const retained = selected.replaceForward ? selected.backward : selected.forward;
  let oldEdge = selected.replaceForward ? selected.end.edgeIndex : selected.start.edgeIndex;
  for (let index = 0; index < retained.length - 1; index++) {
    const newEdge = (replacement.length - 1 + index - offset + candidate.length) % candidate.length;
    edgeRemap[oldEdge].push(newEdge);
    oldEdge = (oldEdge + 1) % selected.polygon.length;
  }
  const protectedHoles = [...holes, ...openings];
  const edit = prepareOutlineEdit(outlines, selected.start.outlineIndex, ordered, protectedHoles);
  if (edit.error) return { ...edit, holes };
  if (edit.outlines.length !== outlines.length || JSON.stringify(edit.holes) !== JSON.stringify(protectedHoles)) {
    return reject("the redraw would change a cutout, opening or roof component. Choose another path.");
  }
  return { ...edit, holes, editedOutlineIndex: selected.start.outlineIndex, edgeRemap };
}
