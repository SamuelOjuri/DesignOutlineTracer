import polygonClipping, { type Polygon } from "polygon-clipping";
import type { PageSession, PenetrationScope } from "@/types/roi";
import type { Point } from "@/types/roof";
import { acceptedRoofRegions } from "./penetrationAssociation";
import { boxToSource } from "./roiCoordinates";
import { validPenetrationRing } from "./penetrationGeometry";

const polygon = (points: Point[]): Polygon => [points.map(p => [p.x, p.y])];
const points = (ring: number[][]): Point[] => ring.slice(0, -1).map(([x, y]) => ({ x, y }));

/** Detection sees actual insulation scope and manual exclusions, not existing suggestions. */
export function penetrationScopes(page: PageSession): PenetrationScope[] {
  const size = { width: page.source.source_width, height: page.source.source_height };
  const result: PenetrationScope[] = [];
  try {
    const holes = page.drawing.holes.filter(hole => hole.points.length >= 3).map(hole => polygon(hole.points));
    for (const parent of acceptedRoofRegions(page)) {
      const { x, y, width, height } = boxToSource(parent.box_2d, size);
      const region = polygon([{ x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height }]);
      for (const outline of page.drawing.outlines) {
        if (outline.points.length < 3 || (outline.roi_id !== null && outline.roi_id !== parent.id)) continue;
        const clipped = polygonClipping.intersection(polygon(outline.points), region);
        const usable = holes.length ? polygonClipping.difference(clipped, ...holes) : clipped;
        for (const part of usable) result.push({ roi_id: parent.id, outline_id: outline.id,
          outer: points(part[0]), holes: part.slice(1).map(points) });
      }
    }
    if (result.length > 100 || result.some(scope => !validPenetrationRing(scope.outer, size, 512)
      || scope.holes.some(hole => !validPenetrationRing(hole, size, 512)))
      || result.reduce((sum, scope) => sum + scope.outer.length + scope.holes.reduce((n, hole) => n + hole.length, 0), 0) > 8192) return [];
    return result.sort((a, b) => a.roi_id.localeCompare(b.roi_id) || a.outline_id.localeCompare(b.outline_id));
  } catch { return []; }
}
