import { describe, expect, it } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { emptyDrawing, initialRoiState, roiSessionReducer } from "./roiSession";
import { combinePageDrawings, editorDrainage, reconcilePolygons, shiftedOffsets } from "./roiDrawing";

const scale = { paperSize: "A1", scaleRatio: 100 };
const points = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }];

function page(id: string, factor = 1) {
  const state = roiSessionReducer(initialRoiState, { type: "activate", source: syntheticPage(id, factor), scale });
  return { ...state.pages[id], annotations: [syntheticAnnotation("roi", { page_id: id })], drawing: { ...emptyDrawing(scale),
    outlines: [{ id: `outline-${id}`, page_id: id, roi_id: "roi", points }],
    holes: [{ id: `hole-${id}`, page_id: id, roi_id: "roi", points: [{ x: 150, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 180 }] }],
    outlets: [{ id: `outlet-${id}`, page_id: id, x: 200, y: 200, diameter: 0.15 }],
    drainage_edges: [{ outline_id: `outline-${id}`, edge_index: 1 }] } };
}

describe("manual editor boundary", () => {
  it("keeps IDs and ROI links through reordering and explicitly identified outline edits", () => {
    const first = page("first").drawing.outlines[0];
    const second = { ...first, id: "second", points: points.map((point) => ({ x: point.x + 500, y: point.y })) };
    const reordered = reconcilePolygons([first, second], [second.points, first.points], "first");
    expect(reordered.map((polygon) => polygon.id)).toEqual(["second", first.id]);
    const edited = reconcilePolygons(reordered, [second.points.map((point) => ({ ...point, y: point.y + 0.25 })), first.points], "first", 0);
    expect(edited[0]).toMatchObject({ id: "second", roi_id: "roi" });
    const session = page("first");
    session.drawing.outlines = [second, first];
    expect(editorDrainage(session)).toEqual([{ outlineIndex: 1, edgeIndex: 1 }]);
  });

  it("keeps source pages unchanged when combining, rescaling and moving illustration objects", () => {
    const pages = [page("first"), page("second", 2)];
    const original = JSON.stringify(pages);
    const combined = combinePageDrawings(pages);
    expect(combined.roofOutlines[1][0]).toEqual({ x: 440, y: 50 });
    expect(combined.outlets[1]).toMatchObject({ x: 490, y: 100, diameter: 0.15 });
    expect(combined.drainageEdges).toEqual([{ outlineIndex: 0, edgeIndex: 1 }, { outlineIndex: 1, edgeIndex: 1 }]);
    expect(combined.outlineRefs[1]).toEqual({ id: "outline-second", page_id: "second", roi_id: "roi" });
    const before = combined.roofOutlines.map((polygon) => polygon[0]);
    const offsets = shiftedOffsets({}, combined.outlineRefs, before, [before[0], { x: 455.5, y: 70.25 }]);
    expect(combinePageDrawings(pages, offsets).roofOutlines[1][0]).toEqual({ x: 455.5, y: 70.25 });
    expect(JSON.stringify(pages)).toBe(original);
    expect(combinePageDrawings(pages)).toEqual(combined);
  });
});