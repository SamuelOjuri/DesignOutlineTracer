import { describe, expect, it } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import type { Box2D, RoiAnnotation } from "@/types/roi";
import { initialRoiState, roiSessionReducer } from "./roiSession";
import { penetrationAssociationWarnings } from "./penetrationAssociation";

function fixture() {
  const source = syntheticPage();
  let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
  state = roiSessionReducer(state, { type: "add", page_id: source.page_id,
    annotation: syntheticAnnotation("parent", { box_2d: [0, 0, 1000, 1000] }) });
  state = roiSessionReducer(state, { type: "drawing", page_id: source.page_id, drawing: { ...state.pages[source.page_id].drawing,
    outlines: [{ id: "outline", page_id: source.page_id, roi_id: "parent", points: [
      { x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 180 }, { x: 240, y: 180 }, { x: 240, y: 600 }, { x: 0, y: 600 },
    ] }], holes: [{ id: "hole", page_id: source.page_id, roi_id: "parent", points: [
      { x: 40, y: 30 }, { x: 160, y: 30 }, { x: 160, y: 120 }, { x: 40, y: 120 },
    ] }] } });
  return state;
}

const child = (box_2d: Box2D, patch: Partial<RoiAnnotation> = {}) => syntheticAnnotation("child", {
  kind: "penetration", subtype: "vent", roi_id: "parent", box_2d, proposed_box_2d: box_2d, ...patch,
});

describe("penetration association evidence", () => {
  it("distinguishes in-roof, concave empty space, boundary and cutout cases on a non-square source", () => {
    const page = fixture().pages["page-1"];
    expect(penetrationAssociationWarnings(child([350, 50, 400, 100]), page)).toEqual([]);
    expect(penetrationAssociationWarnings(child([500, 500, 600, 600]), page)).toContain("Outside the drawn roof or inside a cutout; verify scope.");
    expect(penetrationAssociationWarnings(child([100, 100, 150, 150]), page)).toContain("Outside the drawn roof or inside a cutout; verify scope.");
    expect(penetrationAssociationWarnings(child([250, 500, 350, 600]), page)).toContain("Crosses the drawn roof or cutout boundary; verify membership.");
  });

  it("flags missing parents, outside-ROI detections and overlapping parent ambiguity", () => {
    const page = fixture().pages["page-1"];
    expect(penetrationAssociationWarnings(child([350, 50, 400, 100], { roi_id: null }), page)[0]).toMatch(/unresolved/);
    page.annotations[0].box_2d = [0, 0, 300, 300];
    expect(penetrationAssociationWarnings(child([400, 400, 500, 500]), page)[0]).toMatch(/Outside the assigned/);
    page.annotations.push(syntheticAnnotation("other", { box_2d: [0, 0, 500, 500] }));
    expect(penetrationAssociationWarnings(child([200, 200, 250, 250]), page)).toContain("Overlaps another accepted roof area; verify the parent association.");
  });

  it("keeps valid accepted box corrections current but requires re-review for parent reassignment", () => {
    let state = fixture();
    const drawing = state.pages["page-1"].drawing;
    state = roiSessionReducer(state, { type: "add", page_id: "page-1", annotation: child([500, 500, 600, 600]) });
    expect(state.pages["page-1"].annotations.at(-1)?.validity).toBe("needs_review");
    state = roiSessionReducer(state, { type: "review", page_id: "page-1", id: "child", patch: { review_status: "accepted", validity: "current" } });
    expect(state.pages["page-1"].annotations.at(-1)?.validity).toBe("current");
    state = roiSessionReducer(state, { type: "review", page_id: "page-1", id: "child", patch: { box_2d: [350, 50, 400, 100] } });
    expect(state.pages["page-1"].annotations.at(-1)).toMatchObject({ validity: "current", review_status: "accepted", proposed_box_2d: [500, 500, 600, 600] });
    state = roiSessionReducer(state, { type: "review", page_id: "page-1", id: "child", patch: { roi_id: "missing", validity: "current" } });
    state = roiSessionReducer(state, { type: "review", page_id: "page-1", id: "child", patch: { validity: "current" } });
    expect(state.pages["page-1"].annotations.at(-1)?.validity).toBe("needs_review");
    expect(state.pages["page-1"].drawing).toBe(drawing);
  });
});
