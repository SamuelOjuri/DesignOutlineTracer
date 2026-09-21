import type { Box2D } from "@/types/roi";
import { boxToSource, type SourceSize } from "./roiCoordinates";

/** Source-pixel selection domain. Without accepted ROIs, manual filling stays unrestricted. */
export function buildRoiFillMask(boxes: readonly Box2D[], size: SourceSize): Uint8Array | undefined {
  if (boxes.length === 0) return undefined;
  const mask = new Uint8Array(size.width * size.height);
  for (const box of boxes) {
    const rect = boxToSource(box, size);
    // Include only whole pixels inside the rectangle, keeping extracted edges inside it too.
    const left = Math.ceil(rect.x);
    const top = Math.ceil(rect.y);
    const right = Math.floor(box[3] * size.width / 1000);
    const bottom = Math.floor(box[2] * size.height / 1000);
    if (right <= left || bottom <= top) continue;
    for (let y = top; y < bottom; y++) mask.fill(1, y * size.width + left, y * size.width + right);
  }
  return mask;
}
