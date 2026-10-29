import polygonClipping, { type Polygon } from "polygon-clipping";
import type { OutlineResponse } from "@/types/outline";
import type { PageDrawing, PageSession } from "@/types/roi";
import type { Point } from "@/types/roof";

const EPSILON = 1e-7;
const polygon = (points: Point[]): Polygon => [points.map(point => [point.x, point.y])];
const area = (points: Point[]) => Math.abs(points.reduce((sum, p, i) => {
  const next = points[(i + 1) % points.length];
  return sum + p.x * next.y - next.x * p.y;
}, 0) / 2);
const cross = (a: Point, b: Point, c: Point) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const onSegment = (a: Point, b: Point, p: Point) => Math.abs(cross(a, b, p)) < EPSILON
  && p.x >= Math.min(a.x, b.x) - EPSILON && p.x <= Math.max(a.x, b.x) + EPSILON
  && p.y >= Math.min(a.y, b.y) - EPSILON && p.y <= Math.max(a.y, b.y) + EPSILON;
function touches(a: Point, b: Point, c: Point, d: Point): boolean {
  return (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0)
    || onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function ringsTouch(first: Point[], second: Point[]): boolean {
  return first.some((p, i) => second.some((q, j) => touches(p, first[(i + 1) % first.length], q, second[(j + 1) % second.length])));
}
export function validOutlineRing(points: Point[]): boolean {
  if (points.length < 3 || points.length > 128 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    || area(points) < 1 || new Set(points.map(p => `${p.x},${p.y}`)).size !== points.length) return false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], previous = points[(i + points.length - 1) % points.length];
    if (Math.abs(cross(previous, a, b)) < EPSILON
      && (previous.x - a.x) * (b.x - a.x) + (previous.y - a.y) * (b.y - a.y) > 0) return false;
    for (let j = i + 1; j < points.length; j++) {
      if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
      if (touches(a, b, points[j], points[(j + 1) % points.length])) return false;
    }
  }
  return true;
}

export function outlineResponseError(page: PageSession, response: OutlineResponse): string | null {
  const parent = page.annotations.find(a => a.id === response.roi_id && a.kind === "roof_roi"
    && a.review_status === "accepted" && a.validity === "current");
  if (response.page_id !== page.source.page_id || response.source_image_hash !== page.source.source_image_hash
    || response.roi_revision !== page.roi_revision || response.geometry_revision !== page.geometry_revision
    || !parent || response.roi_annotation_revision !== parent.revision) return "The page or roof scope changed. Generate a new outline.";
  const { source_width: width, source_height: height } = page.source;
  const [top, left, bottom, right] = parent.box_2d;
  if (response.crop.x < 0 || response.crop.y < 0 || response.crop.x + response.crop.width > width + EPSILON
    || response.crop.y + response.crop.height > height + EPSILON) return "The outline response has an invalid crop.";
  try {
    for (const item of response.proposals) {
      if (!validOutlineRing(item.points) || !validOutlineRing(item.proposed_points)
        || item.points.some(p => p.x < left * width / 1000 - EPSILON || p.x > right * width / 1000 + EPSILON
          || p.y < top * height / 1000 - EPSILON || p.y > bottom * height / 1000 + EPSILON)
        || item.proposed_points.some(p => p.x < 0 || p.x > width || p.y < 0 || p.y > height)) {
        return "The proposed boundary is invalid or extends outside the accepted roof region.";
      }
    }
    for (let i = 0; i < response.proposals.length; i++) for (let j = i + 1; j < response.proposals.length; j++) {
      const a = response.proposals[i].points, b = response.proposals[j].points;
      if (ringsTouch(a, b) || polygonClipping.intersection(polygon(a), polygon(b)).length) return "Proposed roof components overlap or touch.";
    }
  } catch { return "The proposed boundary could not be validated."; }
  return null;
}

export function cloneOutlineDrawing(drawing: PageDrawing): PageDrawing {
  return { ...drawing, drawing_scale: { ...drawing.drawing_scale },
    outlines: drawing.outlines.map(p => ({ ...p, points: p.points.map(point => ({ ...point })) })),
    holes: drawing.holes.map(p => ({ ...p, points: p.points.map(point => ({ ...point })) })),
    outlets: drawing.outlets.map(outlet => ({ ...outlet })), drainage_edges: drawing.drainage_edges.map(edge => ({ ...edge })) };
}

/** Build one atomic scope replacement. Never silently overwrite an unrelated roof. */
export function prepareOutlineApplication(page: PageSession, response: OutlineResponse, replacementIds: readonly string[]): {
  drawing: PageDrawing | null; error: string | null;
} {
  const reject = (error: string) => ({ drawing: null, error });
  const invalid = outlineResponseError(page, response);
  if (invalid) return reject(invalid);
  if (!response.proposals.length || !["complete", "needs_review"].includes(response.status)) return reject("There is no usable outline to apply.");
  const replacements = new Set(replacementIds);
  const removed = page.drawing.outlines.filter(p => replacements.has(p.id));
  if (replacements.size !== replacementIds.length || removed.length !== replacements.size
    || removed.some(p => p.roi_id !== null && p.roi_id !== response.roi_id)) return reject("Choose only outlines belonging to this roof region.");
  const unaffected = page.drawing.outlines.filter(p => !replacements.has(p.id));
  try {
    const scope = response.proposals.map(p => polygon(p.points));
    const affectedHoles = page.drawing.holes.filter(hole =>
      [...removed.map(old => polygon(old.points)), ...scope]
        .some(region => polygonClipping.intersection(region, polygon(hole.points)).length));
    const affectedIds = new Set(affectedHoles.map(h => h.id));
    const retainedHoles = page.drawing.holes.filter(hole => !affectedIds.has(hole.id));
    const combined = polygonClipping.union(scope[0], ...scope.slice(1));
    const cut = affectedHoles.length ? polygonClipping.difference(combined, ...affectedHoles.map(h => polygon(h.points))) : combined;
    if (!cut.length) return reject("Existing cutouts exclude the proposed insulation scope.");
    const points = (ring: number[][]): Point[] => ring.slice(0, -1).map(([x, y]) => ({ x, y }));
    const generated = cut.map((part, index) => ({ id: `outline_${response.request_id}_${index}`, page_id: response.page_id,
      roi_id: response.roi_id, points: points(part[0]) }));
    for (const candidate of generated) {
      if (!validOutlineRing(candidate.points)) return reject("The boundary cannot be reconciled with existing cutouts.");
      for (const other of unaffected) {
        if (ringsTouch(candidate.points, other.points) || polygonClipping.intersection(polygon(candidate.points), polygon(other.points)).length) {
          return reject("The generated outline overlaps an existing roof. Select that outline for replacement or refine the region.");
        }
      }
    }
    const holes = cut.flatMap((part, outerIndex) => part.slice(1).map((ring, holeIndex) => ({
      id: `hole_${response.request_id}_${outerIndex}_${holeIndex}`, page_id: response.page_id,
      roi_id: response.roi_id, points: points(ring),
    })));
    return { error: null, drawing: cloneOutlineDrawing({ ...page.drawing, outlines: [...unaffected, ...generated],
      holes: [...retainedHoles, ...holes], drainage_edges: page.drawing.drainage_edges.filter(edge => !replacements.has(edge.outline_id)) }) };
  } catch { return reject("The outline could not be combined with existing roof geometry."); }
}
