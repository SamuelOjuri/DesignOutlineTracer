import { describe, expect, it } from "vitest";
import type { Box2D, DetectionRun, RenderedPdfPage, RoiAnnotation } from "@/types/roi";
import { initialRoiState, roiSessionReducer } from "./roiSession";

const source: RenderedPdfPage = {
  page_id: "page-one", document_id: "document-one", file_name: "roof.pdf", page_index: 0,
  source_image_hash: "hash", source_width: 1200, source_height: 800, render_scale: 1,
  render_rotation: 0, render_version: "test", pdf_view_box: [0, 0, 1200, 800], source_blob: new Blob(),
};
const proposal = (id: string, box: Box2D): RoiAnnotation => ({
  id, page_id: source.page_id, kind: "roof_roi", label: "Roof", box_2d: box, proposed_box_2d: box,
  roi_id: null, origin: "gemini", review_status: "suggested", validity: "current", revision: 1, edits: [], warnings: [],
});
const run: DetectionRun = {
  page_id: source.page_id, request_id: "rerun", task: "roof_roi", source_image_hash: source.source_image_hash,
  roi_revision: null, geometry_revision: 0, model: "gemini-3.6-flash", prompt_version: "roof-roi-v1",
  schema_version: "1", settings: {}, started_at: "2026-09-09T12:00:00Z", duration_ms: 10, status: "complete", warnings: [],
};

describe("ROI proposal reconciliation", () => {
  it("flags reruns against original and edited boxes without replacing accepted work or geometry", () => {
    let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    state = roiSessionReducer(state, { type: "add", page_id: source.page_id, annotation: proposal("accepted", [100, 100, 400, 400]) });
    state = roiSessionReducer(state, { type: "review", page_id: source.page_id, id: "accepted",
      patch: { review_status: "accepted", box_2d: [200, 200, 500, 500] } });
    const accepted = state.pages[source.page_id].annotations[0];
    const drawing = state.pages[source.page_id].drawing;
    state = roiSessionReducer(state, { type: "start", request: run });
    state = roiSessionReducer(state, { type: "result", run, annotations: [
      proposal("original-again", [101, 101, 401, 401]), proposal("edited-again", [201, 201, 501, 501]),
      proposal("separate", [600, 600, 800, 800]), proposal("sheet", [0, 0, 1000, 1000]),
    ] });
    const page = state.pages[source.page_id];
    expect(page.annotations[0]).toEqual(accepted);
    expect(page.drawing).toBe(drawing);
    expect(page.annotations.slice(1, 3).every((annotation) => annotation.warnings.some((warning) => warning.includes("duplicate")))).toBe(true);
    expect(page.annotations[3].warnings).toEqual([]);
    expect(page.annotations[4].warnings[0]).toContain("most of the sheet");
    expect(page.annotations[4].review_status).toBe("suggested");
    state = roiSessionReducer(state, { type: "review", page_id: source.page_id, id: "sheet", patch: { review_status: "accepted" } });
    expect(state.pages[source.page_id].annotations[4].review_status).toBe("accepted");
    expect(state.pages[source.page_id].drawing).toBe(drawing);
    state = roiSessionReducer(state, { type: "review", page_id: source.page_id, id: "accepted", patch: { label: "Corrected" } });
    state = roiSessionReducer(state, { type: "undo", page_id: source.page_id });
    expect(state.pages[source.page_id].annotations.map((annotation) => annotation.id))
      .toEqual(["accepted", "original-again", "edited-again", "separate", "sheet"]);
    state = roiSessionReducer(state, { type: "remove", page_id: source.page_id, id: "accepted" });
    state = roiSessionReducer(state, { type: "undo", page_id: source.page_id });
    expect(state.pages[source.page_id].annotations[0].id).toBe("accepted");
  });
});