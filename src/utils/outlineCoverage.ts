import type { PageSession, RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";

export function acceptedRoofRegions(page: PageSession): RoiAnnotation[] {
  return page.annotations.filter(annotation => annotation.kind === "roof_roi"
    && annotation.review_status === "accepted" && annotation.validity === "current");
}

function centroid(points: Point[]): Point {
  let twiceArea = 0, x = 0, y = 0;
  points.forEach((point, index) => {
    const next = points[(index + 1) % points.length];
    const cross = point.x * next.y - next.x * point.y;
    twiceArea += cross;
    x += (point.x + next.x) * cross;
    y += (point.y + next.y) * cross;
  });
  if (Math.abs(twiceArea) < 1e-9) {
    return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
  }
  return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) };
}

/**
 * Accepted roof regions that already have an outline on the page. A generated outline belongs to the region in its
 * `roi_id`; manual, edited or orphaned outlines count for any region whose box contains the outline's centre.
 */
export function outlinedRegionIds(page: PageSession, regions: readonly RoiAnnotation[] = acceptedRoofRegions(page)): Set<string> {
  const ids = new Set(regions.map(region => region.id));
  const outlined = new Set<string>();
  const { source_width: width, source_height: height } = page.source;
  for (const outline of page.drawing.outlines) {
    if (outline.points.length < 3) continue;
    if (outline.roi_id && ids.has(outline.roi_id)) {
      outlined.add(outline.roi_id);
      continue;
    }
    const centre = centroid(outline.points);
    for (const region of regions) {
      const [top, left, bottom, right] = region.box_2d;
      if (centre.x >= left * width / 1000 && centre.x <= right * width / 1000
        && centre.y >= top * height / 1000 && centre.y <= bottom * height / 1000) outlined.add(region.id);
    }
  }
  return outlined;
}

/** The first region after `currentId` (wrapping, in display order) that still needs an outline. */
export function nextRegionToOutline(page: PageSession, currentId: string | null): string | null {
  const regions = acceptedRoofRegions(page);
  const outlined = outlinedRegionIds(page, regions);
  const start = regions.findIndex(region => region.id === currentId);
  for (let step = 1; step <= regions.length; step++) {
    const region = regions[(start + step) % regions.length];
    if (!outlined.has(region.id)) return region.id;
  }
  return null;
}

/** Keep the chosen region while it still needs an outline; otherwise move to the next one that does. */
export function preferredOutlineTarget(page: PageSession, currentId: string | null): string | null {
  const regions = acceptedRoofRegions(page);
  const current = regions.find(region => region.id === currentId)?.id ?? null;
  if (current && !outlinedRegionIds(page, regions).has(current)) return current;
  return nextRegionToOutline(page, current) ?? current;
}
