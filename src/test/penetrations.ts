import { syntheticAnnotation, syntheticPage } from "./roi";
import { initialRoiState, roiSessionReducer } from "@/utils/roiSession";

export function penetrationSession() {
  const source = syntheticPage();
  let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
  state = roiSessionReducer(state, { type: "add", page_id: source.page_id,
    annotation: syntheticAnnotation("parent", { box_2d: [0, 0, 1000, 1000] }) });
  state = roiSessionReducer(state, { type: "drawing", page_id: source.page_id, drawing: { ...state.pages[source.page_id].drawing,
    outlines: [{ id: "scope", page_id: source.page_id, roi_id: "parent", points: [
      { x: 40, y: 40 }, { x: 740, y: 40 }, { x: 740, y: 500 }, { x: 40, y: 500 },
    ] }], holes: [{ id: "manual-hole", page_id: source.page_id, roi_id: "parent", points: [
      { x: 80, y: 80 }, { x: 120, y: 80 }, { x: 120, y: 120 }, { x: 80, y: 120 },
    ] }] } });
  return roiSessionReducer(state, { type: "add", page_id: source.page_id, annotation: syntheticAnnotation("rooflight", {
    kind: "penetration", subtype: "rooflight", roi_id: "parent", review_status: "suggested",
    box_2d: [250, 350, 400, 450], proposed_box_2d: [250, 350, 400, 450],
  }) });
}
