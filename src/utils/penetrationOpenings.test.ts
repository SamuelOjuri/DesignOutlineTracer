import { describe, expect, it } from "vitest";
import { penetrationSession } from "@/test/penetrations";
import { syntheticAnnotation } from "@/test/roi";
import { roiSessionReducer, type RoiSessionAction } from "./roiSession";
import { drawingWithPenetrations, insulationPolygons, penetrationFootprint, penetrationOpenings } from "./penetrationOpenings";
import { combinePageDrawings } from "./roiDrawing";
import polygonClipping from "polygon-clipping";

function editor() {
  let state = penetrationSession();
  const page = () => state.pages["page-1"];
  const dispatch = (action: RoiSessionAction) => { state = roiSessionReducer(state, action); };
  const review = (patch: Extract<RoiSessionAction, { type: "review" }>["patch"]) => dispatch({ type: "review", page_id: "page-1", id: "rooflight", patch });
  const undo = () => dispatch({ type: "undo", page_id: "page-1" });
  const accept = () => review({ review_status: "accepted", validity: "current" });
  return { page, dispatch, review, undo, accept };
}

describe("penetration openings", () => {
  it("creates source-pixel cutouts only after acceptance, without changing the base scope or manual holes", () => {
    const { page, accept, undo } = editor();
    const base = page().drawing;
    expect(penetrationOpenings(page())).toEqual([]);
    accept();
    const openings = penetrationOpenings(page());
    expect(openings).toHaveLength(1);
    expect(openings[0].points).toEqual(expect.arrayContaining([
      { x: 280, y: 150 }, { x: 360, y: 150 }, { x: 360, y: 240 }, { x: 280, y: 240 },
    ]));
    expect(penetrationOpenings(page())).toEqual(openings);
    expect(page().drawing).toBe(base);
    expect(drawingWithPenetrations(page()).holes[0]).toBe(base.holes[0]);
    undo();
    expect(penetrationOpenings(page())).toEqual([]);
    expect(page().drawing).toBe(base);
  });

  it("moves/resizes an accepted opening, and undoes edits, rejection and deletion together with the cutout", () => {
    const { page, accept, review, dispatch, undo } = editor();
    accept();
    const original = penetrationOpenings(page());
    review({ box_2d: [300, 400, 460, 550] });
    expect(page().annotations.find(annotation => annotation.id === "rooflight")?.validity).toBe("current");
    expect(penetrationOpenings(page())[0].points).toContainEqual({ x: 320, y: 180 });
    expect(penetrationOpenings(page())[0].points).toContainEqual({ x: 440, y: 276 });
    undo();
    expect(penetrationOpenings(page())).toEqual(original);
    review({ review_status: "rejected" });
    expect(penetrationOpenings(page())).toEqual([]);
    undo();
    expect(penetrationOpenings(page())).toEqual(original);
    dispatch({ type: "remove", page_id: "page-1", id: "rooflight" });
    expect(penetrationOpenings(page())).toEqual([]);
    undo();
    expect(penetrationOpenings(page())).toEqual(original);
    review({ box_2d: [900, 900, 950, 950] });
    expect(penetrationOpenings(page())).toEqual([]);
    undo();
    expect(penetrationOpenings(page())).toEqual(original);
    expect(page().annotations.find(annotation => annotation.id === "rooflight")?.proposed_box_2d).toEqual([250, 350, 400, 450]);
  });

  it("clips partial boxes to nonrectangular scope, and excludes empty regions and existing holes", () => {
    const { page } = editor();
    const current = page();
    current.drawing.outlines[0].points = [
      { x: 0, y: 0 }, { x: 700, y: 0 }, { x: 700, y: 200 }, { x: 240, y: 200 }, { x: 240, y: 500 }, { x: 0, y: 500 },
    ];
    const child = current.annotations.find(annotation => annotation.id === "rooflight")!;
    const partial = penetrationFootprint({ ...child, box_2d: [250, 350, 400, 450] }, current);
    expect(partial.error).toBeNull();
    expect(Math.max(...partial.openings[0].points.map(point => point.y))).toBe(200);
    expect(penetrationFootprint({ ...child, box_2d: [600, 600, 700, 700] }, current).openings).toEqual([]);
    expect(penetrationFootprint({ ...child, box_2d: [150, 110, 190, 140] }, current).openings).toEqual([]);
    current.annotations[0].box_2d = [0, 0, 300, 400];
    const parentClipped = penetrationFootprint(child, current);
    expect(Math.max(...parentClipped.openings[0].points.map(point => point.x))).toBe(320);
    expect(Math.max(...parentClipped.openings[0].points.map(point => point.y))).toBe(180);
  });

  it("keeps overlapping openings excluded and preserves the previous manual cutouts", () => {
    const { page, accept, dispatch } = editor();
    accept();
    dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation("vent", {
      kind: "penetration", subtype: "vent", roi_id: "parent", box_2d: [300, 400, 450, 500],
    }) });
    const drawing = drawingWithPenetrations(page());
    const scope = insulationPolygons(drawing.outlines.map(outline => outline.points), drawing.holes.map(hole => hole.points));
    expect(polygonClipping.intersection(scope, [[[330, 190], [340, 190], [340, 200], [330, 200]]])).toEqual([]);
    expect(polygonClipping.intersection(scope, [[[90, 90], [100, 90], [100, 100], [90, 100]]])).toEqual([]);
  });

  it("requires re-review after the base scope or parent changes, and never restores stale openings with Undo", () => {
    const { page, accept, dispatch, undo } = editor();
    accept();
    dispatch({ type: "drawing", page_id: "page-1", drawing: { ...page().drawing, outlines: [] } });
    expect(penetrationOpenings(page())).toEqual([]);
    undo();
    expect(penetrationOpenings(page())).toEqual([]);
    const second = editor();
    second.accept();
    second.dispatch({ type: "review", page_id: "page-1", id: "parent", patch: { review_status: "rejected" } });
    expect(penetrationOpenings(second.page())).toEqual([]);
    second.undo();
    expect(penetrationOpenings(second.page())).toEqual([]);
  });

  it("carries opening polygons and physical dimensions into the combined project using the same offsets as cutouts", () => {
    const { page, accept } = editor();
    accept();
    const original = JSON.stringify(page());
    const first = combinePageDrawings([page()]);
    expect(first.penetrations).toHaveLength(1);
    expect(first.penetrations[0]).toMatchObject({ x: 320, y: 195 });
    expect(first.penetrations[0].width).toBeCloseTo(80 * 841 * 100 / 800 / 1000);
    expect(first.penetrations[0].polygonPoints).toEqual(first.interiorHoles[1]);
    const moved = combinePageDrawings([page()], { [first.penetrations[0].id]: { x: 20, y: -10 } });
    expect(moved.penetrations[0]).toMatchObject({ x: 340, y: 185, width: first.penetrations[0].width });
    expect(moved.penetrations[0].polygonPoints).toEqual(moved.interiorHoles[1]);
    expect(JSON.stringify(page())).toBe(original);
  });
});
