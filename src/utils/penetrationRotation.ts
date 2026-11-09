import type { Point } from "@/types/roof";
import type { SourceSize } from "./roiCoordinates";

export interface PenetrationRotationHandle {
  center: Point;
  anchor: Point;
  handle: Point;
}

/** Keep the grip a constant screen distance from the selected boundary and inside the page. */
export function penetrationRotationHandle(points: readonly Point[], size: SourceSize, scale: number): PenetrationRotationHandle {
  const left = Math.min(...points.map(p => p.x)), right = Math.max(...points.map(p => p.x));
  const top = Math.min(...points.map(p => p.y)), bottom = Math.max(...points.map(p => p.y));
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const gap = 34 / Math.max(scale, 0.0001), padding = 14 / Math.max(scale, 0.0001);
  const candidates = [
    { anchor: { x: center.x, y: top }, handle: { x: center.x, y: top - gap } },
    { anchor: { x: center.x, y: bottom }, handle: { x: center.x, y: bottom + gap } },
    { anchor: { x: right, y: center.y }, handle: { x: right + gap, y: center.y } },
    { anchor: { x: left, y: center.y }, handle: { x: left - gap, y: center.y } },
  ];
  const chosen = candidates.find(({ handle }) => handle.x >= padding && handle.x <= size.width - padding
    && handle.y >= padding && handle.y <= size.height - padding) ?? candidates[0];
  const marginX = Math.min(padding, size.width / 2), marginY = Math.min(padding, size.height / 2);
  return { center, anchor: chosen.anchor, handle: {
    x: Math.max(marginX, Math.min(size.width - marginX, chosen.handle.x)),
    y: Math.max(marginY, Math.min(size.height - marginY, chosen.handle.y)),
  } };
}

/** Angle is measured in source pixels; Shift snaps the gesture to 15-degree increments. */
export function penetrationRotationDegrees(center: Point, start: Point, current: Point, snap: boolean): number {
  if (Math.hypot(current.x - center.x, current.y - center.y) < 1e-7) return 0;
  const angle = Math.atan2(current.y - center.y, current.x - center.x) - Math.atan2(start.y - center.y, start.x - center.x);
  const degrees = Math.atan2(Math.sin(angle), Math.cos(angle)) * 180 / Math.PI;
  return snap ? Math.round(degrees / 15) * 15 : degrees;
}
