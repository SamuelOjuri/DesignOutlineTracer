import { OPS } from "pdfjs-dist";
import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";

type Matrix = [number, number, number, number, number, number];
interface OperatorList { fnArray: number[]; argsArray: unknown[][] }
const identity: Matrix = [1, 0, 0, 1, 0, 0];
const multiply = (a: Matrix, b: number[]): Matrix => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const transform = (m: Matrix, x: number, y: number): Point => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

const cross = (a: Point, b: Point, p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
function clipSegment(segment: VectorSegment, polygon: Point[]): VectorSegment | null {
  const orientation = Math.sign(polygon.reduce((sum, p, i) => {
    const q = polygon[(i + 1) % polygon.length]; return sum + p.x * q.y - q.x * p.y;
  }, 0));
  if (!orientation) return null;
  let from = 0, to = 1;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const start = orientation * cross(a, b, segment.start), end = orientation * cross(a, b, segment.end);
    if (start < 0 && end < 0) return null;
    if (start < 0) from = Math.max(from, start / (start - end));
    if (end < 0) to = Math.min(to, start / (start - end));
    if (from > to) return null;
  }
  const at = (t: number) => ({ x: segment.start.x + t * (segment.end.x - segment.start.x),
    y: segment.start.y + t * (segment.end.y - segment.start.y) });
  return { start: at(from), end: at(to) };
}

/** Extract bounded straight stroke evidence using the PDF.js public operator list.
 * Curves, dashed strokes and arbitrary clipping remain available through raster evidence.
 * This is not a semantic roof extractor and never substitutes a curve's chord.
 */
export function extractPdfVectorSegments(list: OperatorList, viewportTransform: readonly number[], width: number, height: number): VectorSegment[] {
  let matrix: Matrix = [...identity], dashed = false, clipped = false;
  let clips: Point[][] = [[{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }]];
  const stack: { matrix: Matrix; dashed: boolean; clipped: boolean; clips: Point[][] }[] = [];
  let path: VectorSegment[] = [], current: Point | null = null, first: Point | null = null;
  const result: VectorSegment[] = [];
  const viewport = [...viewportTransform] as Matrix;
  const mapped = (x: number, y: number) => transform(multiply(viewport, matrix), x, y);
  const append = (end: Point) => { if (current) path.push({ start: current, end }); current = end; };
  const close = () => { if (first && current) append(first); };
  const clear = () => { path = []; current = null; first = null; };
  const save = () => stack.push({ matrix: [...matrix], dashed, clipped, clips: [...clips] });
  const restore = () => { const saved = stack.pop(); if (saved) { matrix = saved.matrix; dashed = saved.dashed; clipped = saved.clipped; clips = saved.clips; } };
  const clipPath = () => {
    const edges = path.filter(edge => Math.hypot(edge.end.x - edge.start.x, edge.end.y - edge.start.y) > 1e-7);
    const corners = edges.map(edge => edge.start);
    const turns = corners.map((p, i) => cross(p, corners[(i + 1) % corners.length], corners[(i + 2) % corners.length]));
    if (edges.length === 4 && edges.every((edge, i) => {
      const next = edges[(i + 1) % edges.length];
      return Math.hypot(edge.end.x - next.start.x, edge.end.y - next.start.y) < 1e-7;
    }) && (turns.every(turn => turn > 0) || turns.every(turn => turn < 0))) clips = [...clips, corners];
    else clipped = true;
  };
  const stroke = () => {
    if (!dashed && !clipped) for (const original of path) {
      if (result.length >= 30000) break;
      if (![original.start, original.end].every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
      let segment: VectorSegment | null = original;
      for (const clip of clips) { if (segment) segment = clipSegment(segment, clip); }
      if (segment) {
        // The page clip is always present; remove interpolation roundoff at its boundary.
        const bounded = (p: Point): Point => ({ x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) });
        segment = { start: bounded(segment.start), end: bounded(segment.end) };
        if (Math.hypot(segment.end.x - segment.start.x, segment.end.y - segment.start.y) >= 2) result.push(segment);
      }
    }
    clear();
  };
  for (let i = 0; i < list.fnArray.length && i < 500000; i++) {
    const op = list.fnArray[i], args = list.argsArray[i] ?? [];
    if (op === OPS.save) save();
    else if (op === OPS.restore) restore();
    else if (op === OPS.transform) matrix = multiply(matrix, args as number[]);
    else if (op === OPS.setDash) dashed = Boolean((args[0] as number[])?.length);
    else if (op === OPS.clip || op === OPS.eoClip) clipPath();
    else if (op === OPS.paintFormXObjectBegin) {
      save();
      if (args[0]) matrix = multiply(matrix, args[0] as number[]);
      if (args[1]) {
        const [left, top, right, bottom] = args[1] as number[];
        clips = [...clips, [mapped(left, top), mapped(right, top), mapped(right, bottom), mapped(left, bottom)]];
      }
    } else if (op === OPS.paintFormXObjectEnd) restore();
    else if (op === OPS.beginGroup) {
      save();
      const group = args[0] as { matrix?: number[] };
      if (group?.matrix) matrix = multiply(matrix, group.matrix);
      clipped = true;
    } else if (op === OPS.endGroup) restore();
    else if (op === OPS.beginAnnotation) { save(); clipped = true; }
    else if (op === OPS.endAnnotation) restore();
    else if (op === OPS.constructPath) {
      const operations = args[0] as number[], coordinates = args[1] as number[];
      let j = 0;
      for (const command of operations) {
        if (command === OPS.moveTo) { current = mapped(coordinates[j++], coordinates[j++]); first = current; }
        else if (command === OPS.lineTo) append(mapped(coordinates[j++], coordinates[j++]));
        else if (command === OPS.rectangle) {
          const x = coordinates[j++], y = coordinates[j++], w = coordinates[j++], h = coordinates[j++];
          current = mapped(x, y); first = current;
          append(mapped(x + w, y)); append(mapped(x + w, y + h)); append(mapped(x, y + h)); close();
        } else if (command === OPS.closePath) close();
        else if (command === OPS.curveTo) { current = mapped(coordinates[j + 4], coordinates[j + 5]); j += 6; }
        else if (command === OPS.curveTo2 || command === OPS.curveTo3) { current = mapped(coordinates[j + 2], coordinates[j + 3]); j += 4; }
        else { clear(); break; }
        if (path.length > 30000) { clear(); break; }
      }
    } else if (op === OPS.closePath) close();
    else if (op === OPS.stroke || op === OPS.fillStroke || op === OPS.eoFillStroke) stroke();
    else if (op === OPS.closeStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke) { close(); stroke(); }
    else if (op === OPS.fill || op === OPS.eoFill || op === OPS.endPath) clear();
  }
  return result;
}
