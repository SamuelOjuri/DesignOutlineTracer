import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
import { prepareOutlineEdit, type OutlineEditResult } from "./polygonAdjust";

export interface SideSection { outlineIndex: number; start: number; end: number }
export interface SideTarget extends VectorSegment { source: "vector" | "image"; support: number }
const subtract = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const unit = (a: Point, b: Point): Point => {
  const length = distance(a, b);
  return { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
};
const along = (point: Point, direction: Point, amount: number): Point =>
  ({ x: point.x + direction.x * amount, y: point.y + direction.y * amount });

export function sideIndices(size: number, start: number, end: number): number[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < 0 || start >= size || end >= size || start === end) return [];
  const result = [start];
  while (result[result.length - 1] !== end) result.push((result[result.length - 1] + 1) % size);
  return result;
}

export function shorterSide(polygon: Point[], first: number, last: number): Pick<SideSection, "start" | "end"> {
  const length = (start: number, end: number) => sideIndices(polygon.length, start, end)
    .slice(0, -1).reduce((total, index) => total + distance(polygon[index], polygon[(index + 1) % polygon.length]), 0);
  return length(first, last) <= length(last, first) ? { start: first, end: last } : { start: last, end: first };
}

/** Suggest a local side, including short returns. The highlighted section always requires user review. */
export function suggestSide(polygon: Point[], edgeIndex: number): Pick<SideSection, "start" | "end"> {
  const size = polygon.length;
  const direction = unit(polygon[edgeIndex], polygon[(edgeIndex + 1) % size]);
  const baseLength = distance(polygon[edgeIndex], polygon[(edgeIndex + 1) % size]);
  const corridor = baseLength * 0.15;
  const belongs = (index: number) => {
    const start = polygon[index], end = polygon[(index + 1) % size];
    const delta = subtract(end, start), length = distance(start, end);
    if (length < 1e-8) return false;
    if ([start, end].some(point => Math.abs(cross(direction, subtract(point, polygon[edgeIndex]))) > corridor)) return false;
    return dot(delta, direction) >= -corridor * 0.1
      && (dot(delta, direction) / length >= Math.cos(Math.PI / 9) || length <= corridor);
  };
  let start = edgeIndex, end = (edgeIndex + 1) % size, edges = 1;
  while (edges < size - 2 && belongs((start + size - 1) % size)) { start = (start + size - 1) % size; edges++; }
  while (edges < size - 2 && belongs(end)) { end = (end + 1) % size; edges++; }
  return { start, end };
}

function intersection(a: Point, b: Point, line: VectorSegment): Point | null {
  const first = subtract(b, a), second = subtract(line.end, line.start);
  const denominator = cross(first, second);
  if (Math.abs(denominator) < Math.hypot(first.x, first.y) * Math.hypot(second.x, second.y) * 0.05) return null;
  const t = cross(subtract(line.start, a), second) / denominator;
  return along(a, first, t);
}

/** Fit only the selected path; adjoining lines retain their direction. No rounding or global simplification. */
export function prepareSideFit(outlines: Point[][], holes: Point[][], openings: Point[][], section: SideSection,
  target: VectorSegment, bounds: { width: number; height: number }): OutlineEditResult {
  const reject = (reason: string): OutlineEditResult => ({ outlines, holes, repaired: false, error: `Fit blocked: ${reason}` });
  const polygon = outlines[section.outlineIndex];
  if (!polygon) return reject("select a roof side first.");
  const path = sideIndices(polygon.length, section.start, section.end);
  if (path.length < 2 || path.length > polygon.length - 1) return reject("select one side with at least two other edges remaining.");
  if ([...polygon, target.start, target.end].some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    || distance(target.start, target.end) < 1e-6) return reject("the target line is invalid.");
  const start = polygon[section.start], end = polygon[section.end], span = distance(start, end);
  if (span < 1e-6 || Math.abs(dot(unit(start, end), unit(target.start, target.end))) < Math.cos(Math.PI / 6)) {
    return reject("choose a line running in the same direction as the selected side.");
  }
  const first = intersection(polygon[(section.start + polygon.length - 1) % polygon.length], start, target);
  const last = intersection(end, polygon[(section.end + 1) % polygon.length], target);
  if (!first || !last) return reject("the target cannot form a stable corner with the adjoining sides. Choose different end corners.");
  if (distance(first, start) > span * 0.35 || distance(last, end) > span * 0.35) return reject("choose a closer line or a different section.");
  const removed = new Set(path.slice(1, -1));
  const candidate = polygon.flatMap((p, index) => removed.has(index) ? []
    : [index === section.start ? first : index === section.end ? last : p]);
  if (candidate.some(p => p.x < 0 || p.y < 0 || p.x > bounds.width || p.y > bounds.height)) return reject("the fitted side would leave the drawing page.");
  // A guided fit must not silently trim a cutout, remove an opening or split a roof.
  const edit = prepareOutlineEdit(outlines, section.outlineIndex, candidate, [...holes, ...openings]);
  if (edit.error) return edit;
  if (edit.outlines.length !== outlines.length || JSON.stringify(edit.holes) !== JSON.stringify([...holes, ...openings])) {
    return reject("the fit would change a cutout, opening or roof component. Choose another line.");
  }
  return { ...edit, holes, editedOutlineIndex: section.outlineIndex };
}

/** Distance from a point to the infinite line through a segment. */
const lineDistance = (line: VectorSegment, point: Point) => Math.abs(cross(unit(line.start, line.end), subtract(point, line.start)));

/** Whether two segments lie on the same drawn line. */
export function sameLine(a: VectorSegment, b: VectorSegment, tolerance = 0.5): boolean {
  if (distance(a.start, a.end) < 1e-6 || distance(b.start, b.end) < 1e-6) return false;
  const axis = unit(a.start, a.end);
  return Math.abs(dot(axis, unit(b.start, b.end))) > 0.9999 && Math.abs(cross(axis, subtract(b.start, a.start))) < tolerance;
}

/** Source segments within 20 degrees of a side. Filter once per side so pointer tracking scans fewer segments. */
export function parallelSegments(segments: readonly VectorSegment[], side: VectorSegment): VectorSegment[] {
  if (distance(side.start, side.end) < 1e-6) return [];
  const direction = unit(side.start, side.end);
  return segments.filter(segment => distance(segment.start, segment.end) >= 1e-6
    && Math.abs(dot(unit(segment.start, segment.end), direction)) >= Math.cos(Math.PI / 9));
}

/**
 * Rank source lines that run beside the side and pass within `radius` of the pointer, merging collinear
 * fragments for support. Lines are matched by their offset from the side, so a gap in the drawn line under
 * the pointer does not hide it. The pointer must stay alongside the side, not beyond its ends.
 */
export function vectorSideTargets(segments: readonly VectorSegment[], side: VectorSegment, pointer: Point, radius: number): SideTarget[] {
  const span = distance(side.start, side.end);
  if (span < 1e-6) return [];
  const direction = unit(side.start, side.end);
  const position = dot(subtract(pointer, side.start), direction);
  if (position < -radius || position > span + radius) return [];
  const parallel = parallelSegments(segments, side);
  const nearby = parallel.filter(segment => {
    const ends = [dot(subtract(segment.start, side.start), direction), dot(subtract(segment.end, side.start), direction)];
    return Math.max(...ends) >= 0 && Math.min(...ends) <= span && lineDistance(segment, pointer) <= radius;
  }).sort((a, b) => lineDistance(a, pointer) - lineDistance(b, pointer));
  const candidates: VectorSegment[] = [];
  for (const segment of nearby) {
    if (candidates.some(line => sameLine(line, segment, 0.25))) continue;
    candidates.push(segment);
    if (candidates.length === 24) break;
  }
  const result: SideTarget[] = [];
  for (const candidate of candidates) {
    const axis = unit(candidate.start, candidate.end);
    const limits = [dot(subtract(side.start, candidate.start), axis), dot(subtract(side.end, candidate.start), axis)].sort((a, b) => a - b);
    const intervals = parallel.flatMap(segment => {
      if (Math.abs(dot(unit(segment.start, segment.end), axis)) < 0.9999
        || [segment.start, segment.end].some(p => Math.abs(cross(axis, subtract(p, candidate.start))) > 0.25)) return [];
      const values = [dot(subtract(segment.start, candidate.start), axis), dot(subtract(segment.end, candidate.start), axis)].sort((a, b) => a - b);
      const start = Math.max(values[0], limits[0]), end = Math.min(values[1], limits[1]);
      return end > start ? [[start, end]] : [];
    }).sort((a, b) => a[0] - b[0]);
    let coverage = 0, end = -Infinity;
    for (const [left, right] of intervals) { coverage += Math.max(0, right - Math.max(left, end)); end = Math.max(end, right); }
    const support = coverage / Math.max(1e-6, limits[1] - limits[0]);
    if (support < 0.45) continue;
    result.push({ start: along(candidate.start, axis, limits[0]), end: along(candidate.start, axis, limits[1]), source: "vector", support });
  }
  return result.slice(0, 6);
}

/**
 * Index of the line to preview while the pointer is tracked. The previous line is kept until another line is
 * closer to the pointer by more than `tolerance`, so the preview does not flicker between close parallel faces.
 */
export function stickyTargetIndex(targets: readonly VectorSegment[], previous: VectorSegment | undefined,
  pointer: Point, tolerance: number): number {
  if (!previous || targets.length < 2) return 0;
  const index = targets.findIndex(target => sameLine(target, previous));
  return index > 0 && lineDistance(targets[index], pointer) <= lineDistance(targets[0], pointer) + tolerance ? index : 0;
}

/** Local image fallback for scans. Only continuous, dark neutral strokes are candidates; red dimensions are excluded. */
export function imageSideTargets(image: Pick<ImageData, "data" | "width" | "height">, side: VectorSegment,
  pointer: Point, radius: number): SideTarget[] {
  const span = distance(side.start, side.end);
  if (span < 8) return [];
  const angle = Math.atan2(side.end.y - side.start.y, side.end.x - side.start.x);
  const samples = Math.min(256, Math.max(16, Math.ceil(span)));
  const candidates: (SideTarget & { score: number })[] = [];
  const searchRadius = Math.min(radius, 20);
  for (let degrees = -15; degrees <= 15; degrees += 1) {
    const axis = { x: Math.cos(angle + degrees * Math.PI / 180), y: Math.sin(angle + degrees * Math.PI / 180) };
    const normal = { x: -axis.y, y: axis.x };
    for (let offset = -searchRadius; offset <= searchRadius; offset += 1) {
      const anchor = along(pointer, normal, offset);
      const start = along(anchor, axis, dot(subtract(side.start, anchor), axis));
      const end = along(anchor, axis, dot(subtract(side.end, anchor), axis));
      let hits = 0, gap = 0, longestGap = 0;
      for (let sample = 0; sample <= samples; sample++) {
        const t = sample / samples;
        const x = Math.round(start.x + (end.x - start.x) * t), y = Math.round(start.y + (end.y - start.y) * t);
        const index = (y * image.width + x) * 4;
        const rgb = [image.data[index], image.data[index + 1], image.data[index + 2]];
        const dark = x >= 0 && y >= 0 && x < image.width && y < image.height
          && image.data[index + 3] > 128 && Math.max(...rgb) < 165 && Math.max(...rgb) - Math.min(...rgb) < 45;
        if (dark) { hits++; gap = 0; } else { gap++; longestGap = Math.max(longestGap, gap); }
      }
      const support = hits / (samples + 1);
      if (support < 0.75 || longestGap > samples * 0.15) continue;
      candidates.push({ start, end, source: "image", support, score: support - Math.abs(offset) / Math.max(1, searchRadius) * 0.15 });
    }
  }
  const results: SideTarget[] = [];
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (results.some(line => Math.abs(dot(unit(line.start, line.end), unit(candidate.start, candidate.end))) > 0.999
      && Math.abs(cross(unit(line.start, line.end), subtract(candidate.start, line.start))) < 2)) continue;
    results.push(candidate);
    if (results.length === 4) break;
  }
  return results;
}
