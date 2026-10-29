import type { OutletRequest, OutletResponse } from "@/types/outlet";
import type { PageSession } from "@/types/roi";
import { outletScopes, outletScopeSignature } from "@/utils/outletScope";
import { syntheticAnnotation, syntheticPage } from "./roi";

export function outletPage(): PageSession {
  return {
    source: { ...syntheticPage(), source_image_hash: "a".repeat(64) },
    annotations: [syntheticAnnotation()], roi_revision: 1, geometry_revision: 1, revision: 1,
    pending: {}, used_request_ids: [], runs: [], history: [],
    drawing: {
      drawing_scale: { paperSize: "A1", scaleRatio: 50 }, holes: [], outlets: [], drainage_edges: [],
      outlines: [{ id: "outline-1", page_id: "page-1", roi_id: "roi-1",
        points: [{ x: 200, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 300 }, { x: 200, y: 300 }] }],
    },
  };
}

export function outletRequest(page = outletPage()): OutletRequest {
  return { contract_version: "outlet-1", page_id: page.source.page_id, request_id: "outlet-request-1",
    source_image_hash: page.source.source_image_hash, scope_signature: outletScopeSignature(page),
    roi_revision: page.roi_revision, geometry_revision: page.geometry_revision,
    accepted_rois: page.annotations.filter(annotation => annotation.kind === "roof_roi")
      .map(roi => ({ id: roi.id, revision: roi.revision, box_2d: roi.box_2d })), scopes: outletScopes(page) };
}

export function outletResponse(request = outletRequest()): OutletResponse {
  return { contract_version: "outlet-1", page_id: request.page_id, request_id: request.request_id,
    source_image_hash: request.source_image_hash, scope_signature: request.scope_signature,
    status: "complete", model: "gemini-4-argon", prompt_version: "rainwater-outlet-v1", warnings: [],
    annotations: [{ id: "outlet-annotation-1", page_id: request.page_id, kind: "rainwater_outlet", label: "Terrace inlet",
      subtype: "internal_outlet", roi_id: "roi-1", outline_id: "outline-1", origin: "gemini", review_status: "suggested",
      validity: "current", revision: 1, edits: [], warnings: [], box_2d: [190, 270, 210, 290],
      proposed_box_2d: [190, 270, 210, 290], anchor: { x: 225, y: 120 }, proposed_anchor: { x: 225, y: 120 },
      evidence: "Gully symbol with rainwater callout." }],
  };
}
