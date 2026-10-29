import polygonClipping, { type Polygon } from "polygon-clipping";
import type { Outlet, Point } from "@/types/roof";
import type { PageOutlet, PageSession, RoiAnnotation } from "@/types/roi";
import type { OutletScope } from "@/types/outlet";
import { acceptedRoofRegions } from "./penetrationAssociation";
import { penetrationOpenings } from "./penetrationOpenings";
import { boxToSource } from "./roiCoordinates";

const polygon = (points: Point[]): Polygon => [points.map(({ x, y }) => [x, y])];
const EPSILON = 1e-6;

/** Actual roof geometry in source pixels; sump geometry is deliberately not involved. */
export function outletScopes(page: PageSession): OutletScope[] {
  const openingRecords = [...page.drawing.holes, ...penetrationOpenings(page)].filter(hole => hole.points.length >= 3);
  const holes = openingRecords.map(hole => polygon(hole.points));
  const scopes: OutletScope[] = [];
  try {
    for (const parent of acceptedRoofRegions(page)) {
      const rect = boxToSource(parent.box_2d, { width: page.source.source_width, height: page.source.source_height });
      const region = polygon([{ x: rect.x, y: rect.y }, { x: rect.x + rect.width, y: rect.y },
        { x: rect.x + rect.width, y: rect.y + rect.height }, { x: rect.x, y: rect.y + rect.height }]);
      for (const outline of page.drawing.outlines) {
        if (outline.points.length < 3 || (outline.roi_id && outline.roi_id !== parent.id)) continue;
        const clipped = polygonClipping.intersection(polygon(outline.points), region);
        const usable = holes.length ? polygonClipping.difference(clipped, ...holes) : clipped;
        if (!usable.length) continue;
        const ringPoints = (ring: number[][]) => ring.slice(0, -1).map(([x, y]) => ({ x, y }));
        const excluded = openingRecords.filter(hole => polygonClipping.intersection(polygon(hole.points), clipped).length > 0);
        scopes.push({ roi_id: parent.id, outline_id: outline.id, excluded_openings: excluded.map(hole => hole.points), polygons: usable.map(part => ({
          outer: ringPoints(part[0]), holes: part.slice(1).map(ringPoints),
        })) });
      }
    }
  } catch {
    // Invalid scope must disable detection/acceptance, not become an unrestricted sheet.
    return [];
  }
  return scopes.sort((a, b) => a.roi_id.localeCompare(b.roi_id) || a.outline_id.localeCompare(b.outline_id));
}

/** Synchronous content fingerprint for stale-result checks (not a security credential). */
export function outletScopeSignature(page: PageSession): string {
  const content = JSON.stringify([page.source.source_image_hash, page.roi_revision, page.geometry_revision,
    page.outlet_scope_revision ?? 0, outletScopes(page)]);
  let first = 2166136261, second = 5381;
  for (let index = 0; index < content.length; index++) {
    first = Math.imul(first ^ content.charCodeAt(index), 16777619);
    second = Math.imul(second, 33) ^ content.charCodeAt(index);
  }
  return `outlet-scope-1:${(first >>> 0).toString(16)}:${(second >>> 0).toString(16)}:${content.length}`;
}

function segmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, squared = dx * dx + dy * dy;
  const t = squared ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / squared)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

export function pointInOutletRing(point: Point, ring: Point[], includeBoundary = true): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const a = ring[previous], b = ring[index];
    if (segmentDistance(point, a, b) <= EPSILON) return includeBoundary;
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function pointInOutletScope(point: Point, scope: OutletScope): boolean {
  return scope.polygons.some(part => pointInOutletRing(point, part.outer)
    && !part.holes.some(hole => pointInOutletRing(point, hole)));
}

export function outletAssociation(page: PageSession, annotation: RoiAnnotation): { error: string | null; warnings: string[] } {
  const fail = (error: string) => ({ error, warnings: [error] });
  if (annotation.page_id !== page.source.page_id || annotation.kind !== "rainwater_outlet") return fail("Outlet belongs to another page.");
  if (!annotation.anchor || !Number.isFinite(annotation.anchor.x) || !Number.isFinite(annotation.anchor.y)) return fail("Set the inlet position.");
  if (!["internal_outlet", "parapet_outlet", "scupper"].includes(annotation.subtype ?? "")) return fail("Choose an outlet type.");
  if (!acceptedRoofRegions(page).some(parent => parent.id === annotation.roi_id)) return fail("Choose an accepted current roof area.");
  const scopes = outletScopes(page);
  const assigned = scopes.find(scope => scope.roi_id === annotation.roi_id && scope.outline_id === annotation.outline_id);
  if (!assigned) return fail("Choose an insulation outline for this roof area.");
  // Hole edges remain excluded even when subtracting a touching hole creates an exterior notch.
  if ([...page.drawing.holes, ...penetrationOpenings(page)].some(hole => pointInOutletRing(annotation.anchor!, hole.points))) {
    return fail("The inlet is inside or on an excluded opening.");
  }
  if (!pointInOutletScope(annotation.anchor, assigned)) return fail("The inlet is outside its insulation scope. Correct its position or association.");
  if (page.drawing.outlets.some(outlet => !outlet.annotation_id && Math.hypot(outlet.x - annotation.anchor!.x, outlet.y - annotation.anchor!.y) <= 0.5)
    || page.annotations.some(other => other.id !== annotation.id && other.kind === "rainwater_outlet"
      && !other.deleted && other.review_status === "accepted" && other.validity === "current" && other.anchor
      && other.outline_id === annotation.outline_id && Math.hypot(other.anchor.x - annotation.anchor!.x, other.anchor.y - annotation.anchor!.y) <= 0.5)) {
    return fail("An accepted or manual outlet already occupies this inlet position.");
  }
  const warnings = scopes.some(scope => (scope.roi_id !== assigned.roi_id || scope.outline_id !== assigned.outline_id)
    && pointInOutletScope(annotation.anchor!, scope)) ? ["This position overlaps another roof scope; confirm the assigned roof."] : [];
  return { error: null, warnings };
}

export function outletFromAnnotation(annotation: RoiAnnotation): PageOutlet | null {
  if (!annotation.anchor || annotation.deleted || annotation.review_status === "rejected") return null;
  return { id: annotation.editor_object_id ?? `outlet:${annotation.id}`, page_id: annotation.page_id,
    annotation_id: annotation.id, outline_id: annotation.outline_id, roi_id: annotation.roi_id,
    x: annotation.anchor.x, y: annotation.anchor.y, diameter: annotation.diameter ?? 0.15,
    diameter_confirmed: annotation.diameter_confirmed ?? false,
    subtype: annotation.subtype as Outlet["subtype"], evidence: annotation.evidence,
    review_status: annotation.review_status, validity: annotation.validity };
}

/** Accepted detections are derived, so rejection/delete/undo cannot leave orphan editor objects. */
export function activePageOutlets(page: PageSession): PageOutlet[] {
  const manual = page.drawing.outlets.filter(outlet => !outlet.annotation_id);
  const signature = outletScopeSignature(page);
  const detected = page.annotations.filter(annotation => annotation.kind === "rainwater_outlet"
    && !annotation.deleted && annotation.review_status === "accepted" && annotation.validity === "current"
    && annotation.scope_signature === signature && !outletAssociation(page, annotation).error)
    .flatMap(annotation => { const outlet = outletFromAnnotation(annotation); return outlet ? [outlet] : []; });
  return [...manual, ...detected];
}

export function reviewPageOutlets(page: PageSession): PageOutlet[] {
  return [...page.drawing.outlets.filter(outlet => !outlet.annotation_id), ...page.annotations
    .filter(annotation => annotation.kind === "rainwater_outlet")
    .flatMap(annotation => { const outlet = outletFromAnnotation(annotation); return outlet ? [outlet] : []; })];
}

/** Match either the corrected or original inlet, never across source pages or different roofs. */
export function sameOutletSymbol(page: PageSession, first: RoiAnnotation, second: RoiAnnotation): boolean {
  if (first.page_id !== second.page_id || first.roi_id !== second.roi_id || first.outline_id !== second.outline_id) return false;
  const size = { width: page.source.source_width, height: page.source.source_height };
  const a = boxToSource(first.proposed_box_2d, size), b = boxToSource(second.proposed_box_2d, size);
  const tolerance = Math.max(0.5, Math.min(a.width, a.height, b.width, b.height) * 0.5);
  return [first.anchor, first.proposed_anchor].some(p => p && [second.anchor, second.proposed_anchor]
    .some(q => q && Math.hypot(p.x - q.x, p.y - q.y) <= tolerance));
}
