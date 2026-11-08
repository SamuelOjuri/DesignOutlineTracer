import type { Box2D, RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { boxToSource, validateBox, type SourceSize } from "./roiCoordinates";

const EPS = 1e-7;
export const MAX_PENETRATION_VERTICES = 128;
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) <= EPS
  && p.x >= Math.min(a.x, b.x) - EPS && p.x <= Math.max(a.x, b.x) + EPS
  && p.y >= Math.min(a.y, b.y) - EPS && p.y <= Math.max(a.y, b.y) + EPS;
const touches = (a: Point, b: Point, c: Point, d: Point) => (
  ((cross(a, b, c) > EPS && cross(a, b, d) < -EPS) || (cross(a, b, c) < -EPS && cross(a, b, d) > EPS))
  && ((cross(c, d, a) > EPS && cross(c, d, b) < -EPS) || (cross(c, d, a) < -EPS && cross(c, d, b) > EPS)))
  || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);

export function penetrationArea(points: readonly Point[]): number {
  return Math.abs(points.reduce((sum, p, i) => {
    const next = points[(i + 1) % points.length];
    return sum + p.x * next.y - next.x * p.y;
  }, 0)) / 2;
}

/** Reject invalid drafts rather than silently repairing a reviewed boundary. Concavity is allowed. */
export function validPenetrationRing(points: readonly Point[], size?: SourceSize, maxVertices = MAX_PENETRATION_VERTICES): boolean {
  if (points.length < 3 || points.length > maxVertices || points.some(p => !Number.isFinite(p.x)
    || !Number.isFinite(p.y) || (size && (p.x < -EPS || p.y < -EPS || p.x > size.width + EPS || p.y > size.height + EPS)))
    || penetrationArea(points) < 1) return false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], before = points[(i + points.length - 1) % points.length];
    if (Math.hypot(a.x - b.x, a.y - b.y) <= EPS) return false;
    // Adjacent collinear sides may continue forward, but may not double back.
    if (Math.abs(cross(before, a, b)) <= EPS && (before.x - a.x) * (b.x - a.x) + (before.y - a.y) * (b.y - a.y) > EPS) return false;
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (touches(a, b, points[j], points[(j + 1) % points.length])) return false;
    }
  }
  return true;
}

export function penetrationBoundary(annotation: Pick<RoiAnnotation, "footprint" | "box_2d">, size: SourceSize): Point[] {
  if (annotation.footprint !== undefined) return annotation.footprint.map(p => ({ ...p }));
  const { x, y, width, height } = boxToSource(annotation.box_2d, size);
  return [{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }];
}

export function footprintBox(points: readonly Point[], size: SourceSize): Box2D {
  if (!validPenetrationRing(points, size)) throw new Error("Use a simple opening boundary inside the page with at least three corners.");
  const clamp = (value: number) => Math.max(0, Math.min(1000, value));
  const box: Box2D = [clamp(Math.min(...points.map(p => p.y)) / size.height * 1000),
    clamp(Math.min(...points.map(p => p.x)) / size.width * 1000),
    clamp(Math.max(...points.map(p => p.y)) / size.height * 1000),
    clamp(Math.max(...points.map(p => p.x)) / size.width * 1000)];
  validateBox(box);
  return box;
}

/** Box gestures transform an existing ring instead of replacing it with a rectangle. */
export function transformFootprint(points: readonly Point[], oldBox: Box2D, newBox: Box2D, size: SourceSize): Point[] {
  const before = boxToSource(oldBox, size), after = boxToSource(newBox, size);
  return points.map(p => ({ x: after.x + (p.x - before.x) * after.width / before.width,
    y: after.y + (p.y - before.y) * after.height / before.height }));
}

/** Rotate in source pixels: normalized page axes can have different physical scales. */
export function rotateFootprint(points: readonly Point[], degrees: number, pivot?: Point): Point[] {
  const cx = pivot?.x ?? (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2;
  const cy = pivot?.y ?? (Math.min(...points.map(p => p.y)) + Math.max(...points.map(p => p.y))) / 2;
  const angle = degrees * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  return points.map(p => ({ x: cx + (p.x - cx) * cos - (p.y - cy) * sin,
    y: cy + (p.x - cx) * sin + (p.y - cy) * cos }));
}
