import polygonClipping, { type MultiPolygon, type Polygon } from "polygon-clipping";
import type { Box2D, PageSession, RoiAnnotation } from "@/types/roi";

const { difference, intersection, union } = polygonClipping;

export function acceptedRoofRegions(page: PageSession): RoiAnnotation[] {
  return page.annotations.filter((annotation) => annotation.kind === "roof_roi"
    && annotation.review_status === "accepted" && annotation.validity === "current");
}

function rectangle(box: Box2D): Polygon {
  return [[[box[1], box[0]], [box[3], box[0]], [box[3], box[2]], [box[1], box[2]], [box[1], box[0]]]];
}

function area(polygons: MultiPolygon): number {
  return polygons.reduce((total, polygon) => total + polygon.reduce((sum, ring, ringIndex) => {
    const signedArea = ring.reduce((subtotal, point, index) => {
      const next = ring[(index + 1) % ring.length];
      return subtotal + point[0] * next[1] - next[0] * point[1];
    }, 0) / 2;
    return sum + (ringIndex === 0 ? 1 : -1) * Math.abs(signedArea);
  }, 0), 0);
}

export function penetrationAssociationWarnings(annotation: RoiAnnotation, page: PageSession): string[] {
  if (annotation.kind !== "penetration") return [];
  const parents = acceptedRoofRegions(page);
  const parent = parents.find((candidate) => candidate.id === annotation.roi_id);
  if (!parent) return ["Association unresolved: select an accepted current roof area."];
  const warnings: string[] = [];
  const box = rectangle(annotation.box_2d);
  const boxArea = area([box]);
  const parentOverlap = area(intersection(box, rectangle(parent.box_2d)));
  if (parentOverlap < boxArea - 1e-8) warnings.push(parentOverlap === 0
    ? "Outside the assigned roof area; verify scope or reassign."
    : "Partly outside the assigned roof area; verify membership.");
  if (parents.some((candidate) => candidate.id !== parent.id && area(intersection(box, rectangle(candidate.box_2d))) > 0)) {
    warnings.push("Overlaps another accepted roof area; verify the parent association.");
  }
  const outlines = page.drawing.outlines.filter((outline) => outline.points.length >= 3
    && (outline.roi_id === null || outline.roi_id === parent.id));
  if (!outlines.length) return [...warnings, "No manual roof outline is available for this association."];
  const polygon = (points: typeof outlines[number]["points"]): Polygon => [points.map((point) => [
    point.x / page.source.source_width * 1000, point.y / page.source.source_height * 1000,
  ])];
  try {
    const roof = union(polygon(outlines[0].points), ...outlines.slice(1).map((outline) => polygon(outline.points)));
    const holes = page.drawing.holes.filter((hole) => hole.points.length >= 3
      && (hole.roi_id === null || hole.roi_id === parent.id)).map((hole) => polygon(hole.points));
    const usableRoof = holes.length ? difference(roof, ...holes) : roof;
    const overlap = area(intersection(box, usableRoof));
    if (overlap < boxArea - 1e-8) warnings.push(overlap === 0
      ? "Outside the drawn roof or inside a cutout; verify scope."
      : "Crosses the drawn roof or cutout boundary; verify membership.");
  } catch {
    warnings.push("Roof geometry overlap could not be checked; verify membership.");
  }
  return warnings;
}