import polygonClipping, { type Polygon } from "polygon-clipping";
import { penetrationSubtypes, type PageDrawing, type PagePolygon, type PageSession, type RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { boxToSource } from "./roiCoordinates";

const polygon = (points: Point[]): Polygon => [points.map(({ x, y }) => [x, y])];

/** Resolve the reviewed box against the actual scope, never against display/zoom coordinates. */
export function penetrationFootprint(annotation: RoiAnnotation, page: PageSession): { openings: PagePolygon[]; error: string | null } {
  const reject = (error: string) => ({ openings: [], error });
  if (annotation.kind !== "penetration" || annotation.page_id !== page.source.page_id
    || !penetrationSubtypes.some(subtype => subtype === annotation.subtype)) return reject("Choose a penetration type.");
  const parent = page.annotations.find(candidate => candidate.id === annotation.roi_id && candidate.kind === "roof_roi"
    && candidate.review_status === "accepted" && candidate.validity === "current");
  if (!parent) return reject("Choose an accepted roof area before adding an opening.");
  const outlines = page.drawing.outlines.filter(outline => outline.points.length >= 3
    && (outline.roi_id === null || outline.roi_id === parent.id));
  if (!outlines.length) return reject("Define the insulation scope in Step 3 before adding an opening.");
  try {
    const size = { width: page.source.source_width, height: page.source.source_height };
    const rectangle = (box: RoiAnnotation["box_2d"]): Polygon => {
      const { x, y, width, height } = boxToSource(box, size);
      return polygon([{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]);
    };
    const roof = polygonClipping.union(...outlines.map(outline => polygon(outline.points)) as [Polygon, ...Polygon[]]);
    const clipped = polygonClipping.intersection(roof, rectangle(parent.box_2d), rectangle(annotation.box_2d));
    const holes = page.drawing.holes.filter(hole => hole.points.length >= 3).map(hole => polygon(hole.points));
    const usable = holes.length ? polygonClipping.difference(clipped, ...holes) : clipped;
    if (!usable.length) return reject("Move or resize this box into the insulation scope, outside existing cutouts.");
    // Any interior rings are existing manual cutouts, already excluded by the base
    // drawing. Exterior rings suffice when these openings are unioned with them.
    return { error: null, openings: usable.map((part, index) => ({
      id: `penetration:${annotation.id}:${index}`, page_id: annotation.page_id, roi_id: parent.id,
      points: part[0].slice(0, -1).map(([x, y]) => ({ x, y })),
    })) };
  } catch {
    return reject("The opening could not be calculated. Check the box and the roof boundary.");
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
