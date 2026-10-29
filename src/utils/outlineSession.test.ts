import { describe, expect, it } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { outlineRequest, outlineResponse, steppedOutline } from "@/test/outline";
import { initialRoiState, roiSessionReducer } from "./roiSession";
import { outlineResponseError, prepareOutlineApplication, validOutlineRing } from "./outlineSession";

const rectangle = (x: number, y: number, w: number, h: number) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
function setup() {
  let state = roiSessionReducer(initialRoiState, { type: "activate", source: syntheticPage(), scale: { paperSize: "A1", scaleRatio: 50 } });
  state = roiSessionReducer(state, { type: "add", page_id: "page-1", annotation: syntheticAnnotation() });
  return state;
}

describe("generated outline application", () => {
  it("preserves the exact stepped area without mask expansion and links it to the parent", () => {
    let state = setup();
    const response = outlineResponse(outlineRequest(state.pages["page-1"]));
    state = roiSessionReducer(state, { type: "apply_outline", page_id: "page-1", result: response, replace_outline_ids: [] });
    const page = state.pages["page-1"];
    expect(page.drawing.outlines).toHaveLength(1);
    expect(page.drawing.outlines[0].roi_id).toBe("roi-1");
    expect(new Set(page.drawing.outlines[0].points.map(p => `${p.x},${p.y}`))).toEqual(new Set(steppedOutline.map(p => `${p.x},${p.y}`)));
    expect(page.drawing.holes).toEqual([]);
    expect(page.geometry_revision).toBe(1);
  });

  it("requires explicit replacement and atomically restores holes, outlets and drainage on undo", () => {
    let state = setup();
    const original = { ...state.pages["page-1"].drawing,
      outlines: [{ id: "old", page_id: "page-1", roi_id: "roi-1", points: rectangle(170, 70, 350, 280) },
        { id: "other", page_id: "page-1", roi_id: "other-roi", points: rectangle(650, 400, 100, 100) }],
      holes: [{ id: "hole", page_id: "page-1", roi_id: "roi-1", points: rectangle(400, 120, 30, 40) }],
      outlets: [{ id: "outlet", page_id: "page-1", x: 490, y: 260, diameter: 100 }],
      drainage_edges: [{ outline_id: "old", edge_index: 0 }, { outline_id: "other", edge_index: 0 }] };
    state = roiSessionReducer(state, { type: "drawing", page_id: "page-1", drawing: original });
    state = roiSessionReducer(state, { type: "add", page_id: "page-1", annotation: syntheticAnnotation("light", {
      kind: "penetration", subtype: "rooflight", roi_id: "roi-1", box_2d: [200, 500, 260, 540] }) });
    const response = outlineResponse(outlineRequest(state.pages["page-1"]));
    expect(prepareOutlineApplication(state.pages["page-1"], response, []).error).toContain("overlaps");
    state = roiSessionReducer(state, { type: "apply_outline", page_id: "page-1", result: response, replace_outline_ids: ["old"] });
    expect(state.pages["page-1"].drawing.outlines[0]).toEqual(original.outlines[1]);
    expect(state.pages["page-1"].drawing.outlets).toEqual(original.outlets);
    expect(state.pages["page-1"].drawing.holes).toHaveLength(1);
    expect(state.pages["page-1"].drawing.drainage_edges).toEqual([{ outline_id: "other", edge_index: 0 }]);
    state = roiSessionReducer(state, { type: "undo_outline", page_id: "page-1" });
    expect(state.pages["page-1"].drawing).toEqual(original);
    expect(state.pages["page-1"].annotations.find(a => a.id === "light")?.validity).toBe("needs_review");
  });

  it("rejects stale results and does not undo over later user work", () => {
    let state = setup();
    const response = outlineResponse(outlineRequest(state.pages["page-1"]));
    const newer = roiSessionReducer(state, { type: "review", page_id: "page-1", id: "roi-1", patch: { label: "Changed" } });
    expect(roiSessionReducer(newer, { type: "apply_outline", page_id: "page-1", result: response, replace_outline_ids: [] })).toBe(newer);
    state = roiSessionReducer(state, { type: "apply_outline", page_id: "page-1", result: response, replace_outline_ids: [] });
    state = roiSessionReducer(state, { type: "drawing", page_id: "page-1", drawing: { ...state.pages["page-1"].drawing,
      outlets: [{ id: "later", page_id: "page-1", x: 200, y: 150, diameter: 100 }] } });
    expect(roiSessionReducer(state, { type: "undo_outline", page_id: "page-1" })).toBe(state);
  });

  it("preserves holes in an unselected disjoint roof even when it shares the ROI", () => {
    let state = setup();
    const hole = { id: "retained-hole", page_id: "page-1", roi_id: "roi-1", points: rectangle(190, 270, 10, 10) };
    const old = { id: "untouched", page_id: "page-1", roi_id: "roi-1", points: rectangle(175, 250, 40, 50) };
    state = roiSessionReducer(state, { type: "drawing", page_id: "page-1", drawing: {
      ...state.pages["page-1"].drawing, outlines: [old], holes: [hole] } });
    const response = outlineResponse(outlineRequest(state.pages["page-1"]));
    const prepared = prepareOutlineApplication(state.pages["page-1"], response, []);
    expect(prepared.error).toBeNull();
    expect(prepared.drawing?.outlines[0]).toEqual(old);
    expect(prepared.drawing?.holes).toContainEqual(hole);
  });

  it("rejects self crossing, retraced, touching components, and out-of-region polygons", () => {
    const page = setup().pages["page-1"];
    expect(validOutlineRing([{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }])).toBe(false);
    expect(validOutlineRing([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }])).toBe(false);
    const outside = outlineResponse(outlineRequest(page), rectangle(0, 0, 300, 300));
    expect(outlineResponseError(page, outside)).toContain("outside");
    const touching = outlineResponse(outlineRequest(page), rectangle(200, 100, 100, 100));
    touching.proposals.push({ ...touching.proposals[0], id: "second", points: rectangle(300, 100, 100, 100) });
    expect(outlineResponseError(page, touching)).toContain("touch");
  });
});
