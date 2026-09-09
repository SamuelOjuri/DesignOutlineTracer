import type { Point } from "@/types/roof";
import type { Box2D } from "@/types/roi";

export interface SourceSize { width: number; height: number }
export interface PixelRect extends Point, SourceSize {}
export interface DisplayTransform { scale_x: number; scale_y: number; offset_x: number; offset_y: number }

export function validateBox(box: Box2D): void {
  if (box.length !== 4 || box.some((value) => !Number.isFinite(value) || value < 0 || value > 1000)
    || box[0] >= box[2] || box[1] >= box[3]) throw new Error("Invalid normalized box");
}

function validateSize(size: SourceSize): void {
  if (![size.width, size.height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Invalid source dimensions");
  }
}

function validateTransform(transform: DisplayTransform): void {
  validateSize({ width: transform.scale_x, height: transform.scale_y });
  if (![transform.offset_x, transform.offset_y].every(Number.isFinite)) throw new Error("Invalid display offset");
}

export function boxToSource(box: Box2D, size: SourceSize): PixelRect {
  validateBox(box);
  validateSize(size);
  return { x: box[1] * size.width / 1000, y: box[0] * size.height / 1000,
    width: (box[3] - box[1]) * size.width / 1000, height: (box[2] - box[0]) * size.height / 1000 };
}

export function sourceToBox(rect: PixelRect, size: SourceSize): Box2D {
  validateSize(size);
  validateSize(rect);
  const box: Box2D = [rect.y / size.height * 1000, rect.x / size.width * 1000,
    (rect.y + rect.height) / size.height * 1000, (rect.x + rect.width) / size.width * 1000];
  validateBox(box);
  return box;
}

export function sourceToDisplay(point: Point, transform: DisplayTransform): Point {
  validateTransform(transform);
  return { x: point.x * transform.scale_x + transform.offset_x, y: point.y * transform.scale_y + transform.offset_y };
}

export function displayToSource(point: Point, transform: DisplayTransform): Point {
  validateTransform(transform);
  return { x: (point.x - transform.offset_x) / transform.scale_x, y: (point.y - transform.offset_y) / transform.scale_y };
}

export function boxToDisplay(box: Box2D, size: SourceSize, transform: DisplayTransform): PixelRect {
  const rect = boxToSource(box, size);
  return { ...sourceToDisplay(rect, transform), width: rect.width * transform.scale_x, height: rect.height * transform.scale_y };
}

export function displayToBox(rect: PixelRect, size: SourceSize, transform: DisplayTransform): Box2D {
  return sourceToBox({ ...displayToSource(rect, transform), width: rect.width / transform.scale_x,
    height: rect.height / transform.scale_y }, size);
}

export function cropBoxToPage(box: Box2D, crop: PixelRect, page: SourceSize): Box2D {
  sourceToBox(crop, page);
  const rect = boxToSource(box, crop);
  return sourceToBox({ ...rect, x: rect.x + crop.x, y: rect.y + crop.y }, page);
}

export function pageBoxToCrop(box: Box2D, crop: PixelRect, page: SourceSize): Box2D {
  sourceToBox(crop, page);
  const rect = boxToSource(box, page);
  return sourceToBox({ ...rect, x: rect.x - crop.x, y: rect.y - crop.y }, crop);
}