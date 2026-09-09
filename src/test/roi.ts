import type { DetectionRequest, DetectionRun, RenderedPdfPage, RoiAnnotation } from "@/types/roi";

export function syntheticPage(id = "page-1", factor = 1): RenderedPdfPage {
  return Object.freeze({ document_id: `document-${id}`, file_name: `${id}.pdf`, page_id: id, page_index: 0,
    source_width: 800 * factor, source_height: 600 * factor, source_image_hash: `hash-${id}`,
    render_scale: 2, render_rotation: 0, render_version: "synthetic-v1", pdf_view_box: [0, 0, 400, 300],
    source_blob: new Blob([`unannotated ${id}`], { type: "image/png" }) });
}

export function syntheticAnnotation(id = "roi-1", patch: Partial<RoiAnnotation> = {}): RoiAnnotation {
  return { id, page_id: "page-1", kind: "roof_roi", label: id, box_2d: [100, 200, 600, 700],
    proposed_box_2d: [100, 200, 600, 700], roi_id: null, origin: "manual", review_status: "accepted",
    validity: "current", revision: 1, edits: [], warnings: [], ...patch };
}

export function syntheticRun(request: DetectionRequest): DetectionRun {
  return { ...request, model: "synthetic-provider", prompt_version: "synthetic-v1", schema_version: "1", settings: {},
    started_at: "2026-09-09T00:00:00Z", duration_ms: 1, status: "complete", warnings: [] };
}