import polygonClipping, { type Polygon } from "polygon-clipping";
import type { Point } from "@/types/roof";

export const OUTLET_COLOUR = "#0077CC";
export const OUTLET_SCREEN_RADIUS = 12;
export const OUTLET_HIT_RADIUS = 16;
const BOUNDARY_EPSILON = 1e-6;

export interface MarkerOutlet extends Point {
  outline_id?: string;
  review_status?: "suggested" | "accepted" | "rejected";
  validity?: "current" | "needs_review";
}

export interface OutletMarkerGeometry {
  /** All dimensions are in source/canvas units, including the entire white halo. */
  outerRadius: number;
  circleRadius: number;
  crosshairRadius: number;
  strokeWidth: number;
  haloWidth: number;
  hitRadius: number;
  status: "interior" | "boundary" | "outside";
  clearance: number;
}

export function pointSegmentDistance(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function ringDistance(point: Point, ring: Point[]): number {
  return Math.min(...ring.map((a, index) => pointSegmentDistance(point, a, ring[(index + 1) % ring.length])));
}

function inRing(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Uses the assigned outline, never a neighbouring roof's clearance. Holes stay excluded. */
export function outletMarkerGeometry(outlet: MarkerOutlet, outlines: Point[][], holes: Point[][],
  displayScale: number, outlineIds: string[] = [], boundaryStrokeWidth = 3): OutletMarkerGeometry {
  const scale = Number.isFinite(displayScale) && displayScale > 0 ? displayScale : 1;
  const selected = outlet.outline_id
    ? outlines.filter((_, index) => outlineIds[index] === outlet.outline_id) : outlines;
  let status: OutletMarkerGeometry["status"] = "outside";
  let clearance = 0;
  const validHoles = holes.filter(ring => ring.length >= 3);
  const isExcluded = validHoles.some(ring => inRing(outlet, ring) || ringDistance(outlet, ring) <= BOUNDARY_EPSILON);
  if (!isExcluded) {
    const polygon = (ring: Point[]): Polygon => [ring.map(({ x, y }) => [x, y])];
    const roofs = selected.filter(ring => ring.length >= 3).map(polygon);
    try {
      if (roofs.length) {
        const union = polygonClipping.union(roofs[0], ...roofs.slice(1));
        const scope = validHoles.length ? polygonClipping.difference(union, ...validHoles.map(polygon)) : union;
        for (const component of scope) {
          const rings = component.map(ring => ring.map(([x, y]) => ({ x, y })));
          const outerDistance = ringDistance(outlet, rings[0]);
          if (outerDistance <= BOUNDARY_EPSILON) {
            status = "boundary";
            break;
          }
          if (inRing(outlet, rings[0]) && !rings.slice(1).some(ring => inRing(outlet, ring))) {
            status = "interior";
            clearance = Math.min(...rings.map(ring => ringDistance(outlet, ring)));
            break;
          }
        }
      }
    } catch {
      // Invalid scope cannot establish containment. Keep the point visible for review.
    }
  }
  const preferred = OUTLET_SCREEN_RADIUS / scale;
  const margin = 1 / scale + boundaryStrokeWidth / 2;
  // A true perimeter anchor is deliberately allowed to overlap, without moving or clipping.
  const outerRadius = status === "interior" ? Math.max(0, Math.min(preferred, clearance - margin)) : preferred;
  const ratio = outerRadius / preferred;
  const haloWidth = 4 * ratio / scale;
  return { outerRadius, circleRadius: Math.max(0, outerRadius - haloWidth / 2),
    crosshairRadius: 5 * ratio / scale, strokeWidth: 2 * ratio / scale, haloWidth,
    hitRadius: OUTLET_HIT_RADIUS / scale, status, clearance };
}

/** Transparent glyph: white under-stroke, blue circle and crosshair, optional inner selection ring. */
export function drawOutletMarker(ctx: CanvasRenderingContext2D, outlet: MarkerOutlet,
  geometry: OutletMarkerGeometry, selected = false, offset: Point = { x: 0, y: 0 }): void {
  if (geometry.outerRadius <= 0) return;
  const { circleRadius, crosshairRadius, strokeWidth, haloWidth } = geometry;
  const x = outlet.x + offset.x, y = outlet.y + offset.y;
  ctx.save();
  ctx.lineCap = "round";
  const dashed = outlet.review_status === "suggested" || outlet.validity === "needs_review" || geometry.status === "outside";
  const circle = (width: number, colour: string) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.setLineDash(dashed ? [strokeWidth * 2, strokeWidth * 1.5] : []);
    ctx.beginPath();
    ctx.arc(x, y, circleRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x - crosshairRadius, y); ctx.lineTo(x + crosshairRadius, y);
    ctx.moveTo(x, y - crosshairRadius); ctx.lineTo(x, y + crosshairRadius);
    ctx.stroke();
  };
  circle(haloWidth, "white");
  circle(strokeWidth, OUTLET_COLOUR);
  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, circleRadius * 0.7, 0, Math.PI * 2);
    ctx.lineWidth = strokeWidth * 0.6;
    ctx.stroke();
  }
  ctx.restore();
}
