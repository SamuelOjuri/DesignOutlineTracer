import polygonClipping, { type Polygon } from "polygon-clipping";
import type { Point } from "@/types/roof";

export interface CutoutRectangle { left: number; top: number; right: number; bottom: number }

export function cutoutRectangle(start: Point, end: Point, width: number, height: number): CutoutRectangle {
  return {
    left: Math.max(0, Math.min(width, Math.min(start.x, end.x))),
    top: Math.max(0, Math.min(height, Math.min(start.y, end.y))),
    right: Math.max(0, Math.min(width, Math.max(start.x, end.x))),
    bottom: Math.max(0, Math.min(height, Math.max(start.y, end.y))),
  };
}

function polygon(points: Point[]): Polygon {
  return [points.map(({ x, y }) => [x, y])];
}

/** Geometric subtraction keeps the edges outside the cut unchanged, including tiny fragments. */
export function subtractRectangles(outlines: Point[][], holes: Point[][], rectangles: readonly CutoutRectangle[]) {
  if (!outlines.length || !rectangles.length) return { outlines, holes, changed: false };
  const roof = outlines.map(polygon);
  const usable = holes.length ? polygonClipping.difference(roof, ...holes.map(polygon)) : roof;
  const cuts = rectangles.map(({ left, top, right, bottom }) => polygon([
    { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
  ]));
  if (!polygonClipping.intersection(usable, cuts).length) return { outlines, holes, changed: false };
  const result = polygonClipping.difference(usable, cuts);
  const toPoints = (ring: number[][]): Point[] => ring.slice(0, -1).map(([x, y]) => ({ x, y }));
  return {
    outlines: result.map((part) => toPoints(part[0])),
    holes: result.flatMap((part) => part.slice(1).map(toPoints)),
    changed: true,
  };
}
