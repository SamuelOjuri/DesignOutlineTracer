import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import { penetrationSubtypes, type PageDrawing, type PagePolygon, type PageSession, type RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { boxToSource } from "./roiCoordinates";
import { penetrationArea, penetrationBoundary, validPenetrationRing } from "./penetrationGeometry";

const polygon = (points: Point[]): Polygon => [points.map(({ x, y }) => [x, y])];

const multiArea = (parts: MultiPolygon) => parts.reduce((total, part) => total + part.reduce((sum, ring, i) =>
  sum + (i === 0 ? 1 : -1) * penetrationArea(ring.map(([x, y]) => ({ x, y }))), 0), 0);

/** Resolve the reviewed source-pixel boundary against scope. Legacy boxes remain usable. */
export function penetrationFootprint(annotation: RoiAnnotation, page: PageSession): {
  openings: PagePolygon[]; error: string | null; clipped?: boolean; clipped_fraction?: number;
} {
  const reject = (error: string) => ({ openings: [], error });
  if (annotation.kind !== "penetration" || annotation.page_id !== page.source.page_id
    || !penetrationSubtypes.some(subtype => subtype === annotation.subtype) || annotation.subtype === "unknown") return reject("Choose a penetration type.");
  const parent = page.annotations.find(candidate => candidate.id === annotation.roi_id && candidate.kind === "roof_roi"
    && candidate.review_status === "accepted" && candidate.validity === "current");
  if (!parent) return reject("Choose an accepted roof area before adding an opening.");
  const outlines = page.drawing.outlines.filter(outline => outline.points.length >= 3
    && (outline.roi_id === null || outline.roi_id === parent.id));
  if (!outlines.length) return reject("Define the insulation scope in Step 3 before adding an opening.");
  try {
    const size = { width: page.source.source_width, height: page.source.source_height };
    const boundary = penetrationBoundary(annotation, size);
    if (!validPenetrationRing(boundary, size)) return reject("Use a simple opening boundary inside the page with at least three corners.");
    const rectangle = (box: RoiAnnotation["box_2d"]): Polygon => {
      const { x, y, width, height } = boxToSource(box, size);
      return polygon([{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]);
    };
    const holes = page.drawing.holes.filter(hole => hole.points.length >= 3).map(hole => polygon(hole.points));
    const openings: PagePolygon[] = [];
    let claimed: MultiPolygon = [], usableArea = 0;
    // Ownership is established by clipping each actual roof component, never by a vertex average.
    const ordered = [...outlines].sort((a, b) => Number(b.id === annotation.outline_id) - Number(a.id === annotation.outline_id));
    for (const outline of ordered) {
      const clipped = polygonClipping.intersection(polygon(outline.points), rectangle(parent.box_2d), polygon(boundary));
      const cuts = [...holes, ...claimed];
      const usable = cuts.length ? polygonClipping.difference(clipped, ...cuts) : clipped;
      usableArea += multiArea(usable);
      for (const part of usable) {
        openings.push({ id: `penetration:${annotation.id}:${openings.length}`, annotation_id: annotation.id,
          outline_id: outline.id, page_id: annotation.page_id, roi_id: parent.id,
          // Interior rings are manual cutouts already excluded by the base drawing.
          points: part[0].slice(0, -1).map(([x, y]) => ({ x, y })) });
      }
      if (usable.length) claimed = claimed.length ? polygonClipping.union(claimed, usable) : usable;
    }
    if (!openings.length) return reject(annotation.footprint
      ? "Move this boundary into the insulation scope, outside existing cutouts."
      : "Move or resize this box into the insulation scope, outside existing cutouts.");
    const clippedFraction = Math.max(0, Math.min(1, 1 - usableArea / penetrationArea(boundary)));
    return { error: null, openings, clipped: clippedFraction > 1e-6, clipped_fraction: clippedFraction };
  } catch {
    return reject("The opening could not be calculated. Check its boundary and the roof boundary.");
  }
}

/** Openings are derived from accepted decisions so move/delete/Undo cannot leave orphan cutouts. */
export function penetrationOpenings(page: PageSession): PagePolygon[] {
  return page.annotations.filter(annotation => annotation.kind === "penetration"
    && annotation.review_status === "accepted" && annotation.validity === "current")
    .flatMap(annotation => penetrationFootprint(annotation, page).openings);
}

export function drawingWithPenetrations(page: PageSession): PageDrawing {
  return { ...page.drawing, holes: [...page.drawing.holes, ...penetrationOpenings(page)] };
}

/** Union subtraction also handles overlapping openings and holes belonging to other roofs. */
export function insulationPolygons(outlines: Point[][], holes: Point[][]): Polygon[] {
  const roof = outlines.filter(points => points.length >= 3).map(polygon);
  if (!roof.length) return [];
  const cuts = holes.filter(points => points.length >= 3).map(polygon);
  return cuts.length ? polygonClipping.difference(roof, ...cuts) : roof;
}
