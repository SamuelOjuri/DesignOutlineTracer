import { describe, expect, it } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import type { PageSession, RoiAnnotation, RoiSessionState } from "@/types/roi";
import { initialRoiState, roiSessionReducer, type RoiSessionAction } from "./roiSession";
import { activePageOutlets, outletAssociation, outletScopes, outletScopeSignature, reviewPageOutlets } from "./outletScope";
import { combinePageDrawings } from "./roiDrawing";

const rectangle = (left: number, top: number, right: number, bottom: number) => [
  { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
function setup() {
  let state: RoiSessionState = initialRoiState;
  const dispatch = (action: RoiSessionAction) => { state = roiSessionReducer(state, action); };
  const page = () => state.pages["page-1"];
  dispatch({ type: "activate", source: syntheticPage(), scale: { paperSize: "A1", scaleRatio: 50 } });
  dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation("roi-1", { box_2d: [0, 0, 1000, 1000] }) });
  dispatch({ type: "drawing", page_id: "page-1", drawing: { ...page().drawing,
    outlines: [{ id: "outline-1", page_id: "page-1", roi_id: "roi-1", points: [
      { x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 400 }, { x: 300, y: 400 }, { x: 300, y: 200 }, { x: 100, y: 200 },
    ] }], holes: [{ id: "hole-1", page_id: "page-1", roi_id: "roi-1", points: rectangle(320, 250, 350, 280) }] } });
  const candidate = (patch: Partial<RoiAnnotation> = {}): RoiAnnotation => syntheticAnnotation("outlet-1", {
    kind: "rainwater_outlet", roi_id: "roi-1", outline_id: "outline-1", subtype: "internal_outlet",
    anchor: { x: 120, y: 120 }, proposed_anchor: { x: 120, y: 120 }, box_2d: [190, 140, 210, 160],
    proposed_box_2d: [190, 140, 210, 160], review_status: "suggested", ...patch,
  });
  let sequence = 0;
  const start = () => {
    const request = { page_id: "page-1", request_id: `request-${++sequence}`, task: "rainwater_outlet" as const,
      source_image_hash: page().source.source_image_hash, roi_revision: page().roi_revision,
      geometry_revision: page().geometry_revision, scope_signature: outletScopeSignature(page()) };
    dispatch({ type: "start", request });
    return request;
  };
  const receive = (annotations = [candidate()]) => {
    const request = start();
    dispatch({ type: "outlet-result", page_id: "page-1", request_id: request.request_id, scope_signature: request.scope_signature, annotations });
  };
  const accept = (id = "outlet-1") => dispatch({ type: "outlet-review", page_id: "page-1", id, patch: { review_status: "accepted" } });
  return { page, dispatch, candidate, start, receive, accept };
}

describe("outlet effective scope", () => {
  it("uses the concave scope minus manual and accepted penetration openings; accepts the exterior boundary", () => {
    const { page, candidate, dispatch } = setup();
    expect(outletScopes(page())).toHaveLength(1);
    expect(outletAssociation(page(), candidate({ anchor: { x: 200, y: 300 } })).error).toContain("outside");
    expect(outletAssociation(page(), candidate({ anchor: { x: 330, y: 260 } })).error).toContain("opening");
    expect(outletAssociation(page(), candidate({ anchor: { x: 320, y: 260 } })).error).toContain("opening");
    expect(outletAssociation(page(), candidate({ anchor: { x: 100, y: 100 } })).error).toBeNull();
    dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation("opening", { kind: "penetration", subtype: "rooflight",
      roi_id: "roi-1", box_2d: [180, 140, 240, 180], proposed_box_2d: [180, 140, 240, 180] }) });
    expect(outletAssociation(page(), candidate()).error).toContain("opening");
  });

  it("changes its signature for effective Step 4 decisions but not display scale or outlet edits", () => {
    const { page, dispatch, receive, accept } = setup();
    const before = outletScopeSignature(page());
    receive(); accept();
    expect(outletScopeSignature(page())).toBe(before);
    dispatch({ type: "drawing", page_id: "page-1", drawing: { ...page().drawing, drawing_scale: { paperSize: "A0", scaleRatio: 100 } } });
    expect(outletScopeSignature(page())).toBe(before);
    dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation("opening", { kind: "penetration", subtype: "rooflight",
      roi_id: "roi-1", box_2d: [180, 140, 240, 180], proposed_box_2d: [180, 140, 240, 180] }) });
    expect(outletScopeSignature(page())).not.toBe(before);
    expect(activePageOutlets(page())).toEqual([]);
    expect(reviewPageOutlets(page())[0].validity).toBe("needs_review");
  });
});

describe("outlet review lifecycle", () => {
  it("derives one accepted object, retains corrected anchors on rerun, and rejects/deletes/undoes without orphans", () => {
    const { page, dispatch, candidate, receive, accept } = setup();
    receive();
    expect(activePageOutlets(page())).toEqual([]);
    accept();
    expect(activePageOutlets(page())).toHaveLength(1);
    dispatch({ type: "outlet-move", page_id: "page-1", id: "outlet-1", anchor: { x: 130, y: 120 } });
    receive([candidate({ id: "rerun" })]);
    expect(page().annotations.filter(annotation => annotation.kind === "rainwater_outlet")).toHaveLength(1);
    expect(activePageOutlets(page())[0].x).toBe(130);
    expect(page().annotations.find(annotation => annotation.id === "outlet-1")?.proposed_anchor).toEqual({ x: 120, y: 120 });
    dispatch({ type: "outlet-review", page_id: "page-1", id: "outlet-1", patch: { review_status: "rejected" } });
    expect(activePageOutlets(page())).toEqual([]);
    dispatch({ type: "outlet-undo", page_id: "page-1" });
    expect(activePageOutlets(page())).toHaveLength(1);
    dispatch({ type: "outlet-delete", page_id: "page-1", id: "outlet-1" });
    receive([candidate({ id: "rerun-after-delete" })]);
    expect(reviewPageOutlets(page())).toEqual([]);
    dispatch({ type: "outlet-undo", page_id: "page-1" });
    expect(activePageOutlets(page())[0].x).toBe(130);
  });

  it("blocks outside acceptance, preserves page isolation and rejects a late result after opening changes", () => {
    const { page, dispatch, candidate, receive, accept, start } = setup();
    receive([candidate({ anchor: { x: 200, y: 300 } })]); accept();
    expect(activePageOutlets(page())).toEqual([]);
    const pending = start();
    dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation("opening", { kind: "penetration", subtype: "rooflight",
      roi_id: "roi-1", box_2d: [180, 140, 240, 180], proposed_box_2d: [180, 140, 240, 180] }) });
    expect(page().pending.rainwater_outlet).toBeUndefined();
    dispatch({ type: "outlet-result", page_id: "page-1", request_id: pending.request_id, scope_signature: pending.scope_signature,
      annotations: [candidate({ id: "late" })] });
    expect(page().annotations.some(annotation => annotation.id === "late")).toBe(false);
    const second = start();
    dispatch({ type: "activate", source: syntheticPage("page-2"), scale: { paperSize: "A1", scaleRatio: 50 } });
    dispatch({ type: "outlet-result", page_id: "page-1", request_id: second.request_id, scope_signature: second.scope_signature,
      annotations: [candidate({ id: "wrong-page" })] });
    expect(page().annotations.some(annotation => annotation.id === "wrong-page")).toBe(false);
  });

  it("does not restore stale acceptance on undo, or discard subsequent manual outlets", () => {
    const { page, dispatch, receive, accept } = setup();
    receive(); accept();
    dispatch({ type: "outlet-delete", page_id: "page-1", id: "outlet-1" });
    dispatch({ type: "drawing", page_id: "page-1", drawing: { ...page().drawing,
      outlets: [{ id: "manual", page_id: "page-1", x: 370, y: 350, diameter: 0.15 }],
      holes: [...page().drawing.holes, { id: "new-hole", page_id: "page-1", roi_id: "roi-1", points: rectangle(110, 110, 140, 140) }] } });
    dispatch({ type: "outlet-undo", page_id: "page-1" });
    expect(activePageOutlets(page()).map(outlet => outlet.id)).toEqual(["manual"]);
    expect(page().annotations.find(annotation => annotation.id === "outlet-1")?.validity).toBe("needs_review");
  });

  it("exports only current accepted detections with source ownership, transforms and unconfirmed diameter metadata", () => {
    const { page, receive, accept, dispatch } = setup();
    receive(); accept();
    const result = combinePageDrawings([page()], { "outlet:outlet-1": { x: 20, y: 10 } });
    expect(result.outlets[0]).toMatchObject({ x: 140, y: 130, outline_id: "outline-1", page_id: "page-1",
      annotation_id: "outlet-1", diameter: 0.15, diameter_confirmed: false });
    dispatch({ type: "outlet-move", page_id: "page-1", id: "outlet-1", anchor: { x: 200, y: 300 } });
    expect(combinePageDrawings([page()]).outlets).toEqual([]);
  });
});
