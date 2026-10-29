import type { OutlineRequest, OutlineResponse } from "@/types/outline";
import type { Point } from "@/types/roof";
import type { PageSession } from "@/types/roi";

export const steppedOutline: Point[] = [{ x: 180, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 80 },
  { x: 500, y: 80 }, { x: 500, y: 280 }, { x: 360, y: 280 }, { x: 360, y: 330 },
  { x: 240, y: 330 }, { x: 240, y: 200 }, { x: 180, y: 200 }];
export function outlineRequest(page: PageSession): OutlineRequest {
  const roi = page.annotations.find(a => a.kind === "roof_roi")!;
  return { schema_version: "outline-1", page_id: page.source.page_id, request_id: "outline-request",
    source_image_hash: page.source.source_image_hash, roi_revision: page.roi_revision,
    geometry_revision: page.geometry_revision, roi: { id: roi.id, revision: roi.revision, box_2d: roi.box_2d },
    boundary_policy: "inner_parapet", boundary_notes: "", vector_segments: [] };
}
export function outlineResponse(request: OutlineRequest, points = steppedOutline): OutlineResponse {
  return { schema_version: "outline-1", page_id: request.page_id, request_id: request.request_id,
    source_image_hash: request.source_image_hash, roi_revision: request.roi_revision, geometry_revision: request.geometry_revision,
    roi_id: request.roi.id, roi_annotation_revision: request.roi.revision, boundary_policy: request.boundary_policy,
    status: "complete", proposals: [{ id: "proposal", points: points.map(p => ({ ...p })), proposed_points: points.map(p => ({ ...p })),
      edges: points.map((_, index) => ({ index, support: 1, source: "vector", ambiguous: false })), warnings: [] }],
    warnings: [], crop: { x: 100, y: 40, width: 500, height: 350, inference_width: 500, inference_height: 350 },
    run: { model: "gemini-4-argon", prompt_version: "roof-outline-v1", algorithm_version: "test", settings: {},
      duration_ms: 10, cached: false, provider_attempts: 1 } };
}
