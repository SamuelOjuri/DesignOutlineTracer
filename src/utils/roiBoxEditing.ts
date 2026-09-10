import type { Box2D } from "@/types/roi";
import type { Point } from "@/types/roof";

export type BoxHandle = "move" | "nw" | "ne" | "sw" | "se";
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function editRoiBox(box: Box2D, delta: Point, handle: BoxHandle): Box2D {
  if (handle === "move") {
    const horizontal = clamp(delta.x, -box[1], 1000 - box[3]);
    const vertical = clamp(delta.y, -box[0], 1000 - box[2]);
    return [box[0] + vertical, box[1] + horizontal, box[2] + vertical, box[3] + horizontal];
  }
  return [
    handle.includes("n") ? clamp(box[0] + delta.y, 0, box[2] - 0.001) : box[0],
    handle.includes("w") ? clamp(box[1] + delta.x, 0, box[3] - 0.001) : box[1],
    handle.includes("s") ? clamp(box[2] + delta.y, box[0] + 0.001, 1000) : box[2],
    handle.includes("e") ? clamp(box[3] + delta.x, box[1] + 0.001, 1000) : box[3],
  ];
}

export function drawnRoiBox(start: Point, end: Point): Box2D {
  return [Math.min(start.y, end.y), Math.min(start.x, end.x), Math.max(start.y, end.y), Math.max(start.x, end.x)];
}