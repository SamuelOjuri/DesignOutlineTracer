import polygonClipping, { type Polygon } from "polygon-clipping";
import type { Point } from "@/types/roof";

export const OUTLET_COLOUR = "#C000A0";
export const OUTLET_SCREEN_RADIUS = 12;
export const OUTLET_MIN_SCREEN_RADIUS = 6;
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

/** Uses the assigned outline, never a neighbouring roof's clearance. Holes stay excluded.
 * boundaryStrokeWidth is in source/canvas units, like the returned geometry.
 */
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
  const compact = OUTLET_MIN_SCREEN_RADIUS / scale;
  const margin = 1 / scale + boundaryStrokeWidth / 2;
  // Symbols are annotations, not physical footprints. Prefer containment, but
  // allow overlap rather than making a valid near-edge inlet invisible. Keep
  // the actual anchor and its scope classification independent of display size.
  // Boundary and outside points have no interior clearance: use the compact
  // glyph so unresolved positions do not obscure the source inlet symbol.
  const outerRadius = status === "interior"
    ? Math.max(compact, Math.min(preferred, clearance - margin)) : compact;
  const ratio = outerRadius / preferred;
  const haloWidth = 4 * ratio / scale;
  return { outerRadius, circleRadius: Math.max(0, outerRadius - haloWidth / 2),
    crosshairRadius: 5 * ratio / scale, strokeWidth: 2 * ratio / scale, haloWidth,
    hitRadius: OUTLET_HIT_RADIUS / scale, status, clearance };
}

/** Reviewed outlets on the same roof share a size, bounded by the visible minimum.
 * Pending/invalid suggestions cannot resize accepted markers. Keep the source
 * anchors, physical diameters and screen-sized hit targets independent of ink.
 */
export function outletMarkerGeometries(outlets: readonly MarkerOutlet[], outlines: Point[][], holes: Point[][],
  displayScale: number, outlineIds: string[] = [], boundaryStrokeWidth = 3): OutletMarkerGeometry[] {
  const geometries = outlets.map(outlet => outletMarkerGeometry(outlet, outlines, holes,
    displayScale, outlineIds, boundaryStrokeWidth));
  const groups = outlets.map((outlet, index) => {
    const geometry = geometries[index];
    if ((outlet.review_status && outlet.review_status !== "accepted") || outlet.validity === "needs_review"
      || geometry.status === "outside") return -1;
    return outlet.outline_id ? outlineIds.indexOf(outlet.outline_id)
      : outlines.findIndex(ring => ring.length >= 3 && (inRing(outlet, ring)
        || ringDistance(outlet, ring) <= BOUNDARY_EPSILON));
  });
  const radii = new Map<number, number>();
  groups.forEach((group, index) => {
    if (group >= 0) radii.set(group, Math.min(radii.get(group) ?? Infinity, geometries[index].outerRadius));
  });
  return geometries.map((geometry, index) => {
    const radius = radii.get(groups[index]);
    if (radius === undefined) return geometry;
    const ratio = radius / geometry.outerRadius;
    return { ...geometry, outerRadius: radius, circleRadius: geometry.circleRadius * ratio,
      crosshairRadius: geometry.crosshairRadius * ratio, strokeWidth: geometry.strokeWidth * ratio,
      haloWidth: geometry.haloWidth * ratio };
  });
}

/** Angular gap at each diagonal of a pending marker's broken ring. */
export const PENDING_RING_GAP = Math.PI / 5;

/** Transparent glyph: white under-stroke, magenta circle and crosshair, optional inner selection ring.
 * Pending markers break the magenta ring into four arcs with wide diagonal gaps. A fine dash
 * pattern is not used: at marker size its round caps closed the gaps and blurred the ring.
 */
export function drawOutletMarker(ctx: CanvasRenderingContext2D, outlet: MarkerOutlet,
  geometry: OutletMarkerGeometry, selected = false, offset: Point = { x: 0, y: 0 }): void {
  if (geometry.outerRadius <= 0) return;
  const { circleRadius, crosshairRadius, strokeWidth, haloWidth } = geometry;
  const x = outlet.x + offset.x, y = outlet.y + offset.y;
  ctx.save();
  ctx.setLineDash([]);
  const pending = outlet.review_status === "suggested" || outlet.validity === "needs_review"
    || geometry.status === "outside";
  const sweep = Math.PI / 2 - PENDING_RING_GAP;
  const glyph = (width: number, colour: string, broken: boolean) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = "butt";
    ctx.beginPath();
    if (broken) {
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        const start = quadrant * Math.PI / 2 - sweep / 2;
        ctx.moveTo(x + circleRadius * Math.cos(start), y + circleRadius * Math.sin(start));
        ctx.arc(x, y, circleRadius, start, start + sweep);
      }
    } else ctx.arc(x, y, circleRadius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x - crosshairRadius, y); ctx.lineTo(x + crosshairRadius, y);
    ctx.moveTo(x, y - crosshairRadius); ctx.lineTo(x, y + crosshairRadius);
    ctx.stroke();
  };
  glyph(haloWidth, "white", false);
  glyph(strokeWidth, OUTLET_COLOUR, pending);
  if (selected) {
    ctx.beginPath();
    ctx.arc(x, y, circleRadius * 0.7, 0, Math.PI * 2);
    ctx.lineWidth = strokeWidth * 0.6;
    ctx.stroke();
  }
  ctx.restore();
}
