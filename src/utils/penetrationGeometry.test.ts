import { describe, expect, it } from "vitest";
import { syntheticAnnotation } from "@/test/roi";
import { penetrationSession } from "@/test/penetrations";
import { footprintBox, penetrationArea, penetrationBoundary, rotateFootprint, transformFootprint, validPenetrationRing } from "./penetrationGeometry";
import { penetrationFootprint, penetrationOpenings } from "./penetrationOpenings";
import { penetrationAssociationWarnings } from "./penetrationAssociation";
import { roiSessionReducer } from "./roiSession";
import { penetrationScopes } from "./penetrationScopes";

const size = { width: 800, height: 600 };
const concave = [{ x: 200, y: 200 }, { x: 280, y: 200 }, { x: 280, y: 240 },
  { x: 240, y: 240 }, { x: 240, y: 280 }, { x: 200, y: 280 }];

describe("reviewed penetration boundaries", () => {
  it("preserves rotated, concave and curved footprints instead of deducting their enclosing boxes", () => {
    const page = penetrationSession().pages["page-1"];
    const square = [{ x: 300, y: 200 }, { x: 340, y: 200 }, { x: 340, y: 240 }, { x: 300, y: 240 }];
    const circle = Array.from({ length: 64 }, (_, i) => ({ x: 500 + 25 * Math.cos(i * Math.PI / 32), y: 300 + 25 * Math.sin(i * Math.PI / 32) }));
    for (const footprint of [rotateFootprint(square, 35), concave, circle]) {
      const annotation = syntheticAnnotation("shape", { kind: "penetration", subtype: "riser", roi_id: "parent", footprint,
        box_2d: footprintBox(footprint, size), review_status: "accepted" });
      const result = penetrationFootprint(annotation, page);
      expect(result.error).toBeNull();
      expect(result.clipped).toBe(false);
      expect(result.openings).toHaveLength(1);
      expect(result.openings[0]).toMatchObject({ annotation_id: "shape", outline_id: "scope" });
      expect(penetrationArea(result.openings[0].points)).toBeCloseTo(penetrationArea(footprint), 7);
      expect(result.openings[0].points).toHaveLength(footprint.length);
    }
  });

  it("checks the footprint at a diagonal roof edge without false warnings from its enclosing box", () => {
    const page = penetrationSession().pages["page-1"];
    page.drawing.holes = [];
    page.drawing.outlines[0].points = [{ x: 100, y: 300 }, { x: 300, y: 100 }, { x: 500, y: 300 }, { x: 300, y: 500 }];
    const footprint = [{ x: 190, y: 230 }, { x: 230, y: 190 }, { x: 270, y: 230 }, { x: 230, y: 270 }];
    const annotation = syntheticAnnotation("hatch", { kind: "penetration", subtype: "access_hatch", roi_id: "parent",
      footprint, box_2d: footprintBox(footprint, size) });
    expect(penetrationAssociationWarnings(annotation, page)).toEqual([]);
    expect(penetrationFootprint(annotation, page).clipped).toBe(false);
    expect(penetrationAssociationWarnings({ ...annotation, footprint: undefined }, page)).toContain("Crosses the drawn roof or cutout boundary; verify membership.");
  });

  it("translates and rescales a polygon through box corrections, retaining original geometry and deep undo snapshots", () => {
    let state = penetrationSession();
    const dispatch = (action: Parameters<typeof roiSessionReducer>[1]) => { state = roiSessionReducer(state, action); };
    dispatch({ type: "review", page_id: "page-1", id: "rooflight", patch: { footprint: concave } });
    dispatch({ type: "review", page_id: "page-1", id: "rooflight", patch: { review_status: "accepted" } });
    const before = state.pages["page-1"].annotations.find(a => a.id === "rooflight")!;
    const movedBox = before.box_2d.map(n => n + 50) as [number, number, number, number];
    const expected = transformFootprint(concave, before.box_2d, movedBox, size);
    dispatch({ type: "review", page_id: "page-1", id: "rooflight", patch: { box_2d: movedBox } });
    expect(penetrationOpenings(state.pages["page-1"])[0].points).toEqual(expect.arrayContaining(expected));
    expect(state.pages["page-1"].annotations.find(a => a.id === "rooflight")).toMatchObject({ validity: "current", footprint_source: "manual" });
    dispatch({ type: "undo", page_id: "page-1" });
    expect(state.pages["page-1"].annotations.find(a => a.id === "rooflight")?.footprint).toEqual(concave);
    expect(before.footprint).toEqual(concave);
    expect(before.proposed_box_2d).toEqual([250, 350, 400, 450]);
  });

  it("rejects self-intersection, self-touching, out-of-page and unknown candidates before acceptance", () => {
    for (const footprint of [
      [{ x: 100, y: 100 }, { x: 200, y: 200 }, { x: 100, y: 200 }, { x: 200, y: 100 }],
      [{ x: 100, y: 100 }, { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 150, y: 100 }, { x: 100, y: 200 }],
      concave.map(p => ({ x: p.x - 300, y: p.y })),
    ]) {
      expect(validPenetrationRing(footprint, size)).toBe(false);
      const state = penetrationSession();
      expect(roiSessionReducer(state, { type: "review", page_id: "page-1", id: "rooflight", patch: { footprint } })).toBe(state);
    }
    let state = penetrationSession();
    state = roiSessionReducer(state, { type: "review", page_id: "page-1", id: "rooflight", patch: { subtype: "unknown" } });
    expect(roiSessionReducer(state, { type: "review", page_id: "page-1", id: "rooflight", patch: { review_status: "accepted" } })).toBe(state);
  });

  it("rotates in source pixels on a nonsquare page, preserving physical lengths and area", () => {
    const original = penetrationBoundary({ box_2d: [200, 300, 300, 500] }, size);
    const rotated = rotateFootprint(original, 90);
    expect(penetrationArea(rotated)).toBeCloseTo(penetrationArea(original));
    expect(Math.hypot(rotated[1].x - rotated[0].x, rotated[1].y - rotated[0].y)).toBeCloseTo(160);
    expect(footprintBox(rotated, size)).not.toEqual([200, 300, 300, 500]);
  });

  it("supplies actual roof geometry and manual exclusions while leaving existing penetrations visible to coverage scans", () => {
    let state = penetrationSession();
    const first = penetrationScopes(state.pages["page-1"]);
    expect(first).toHaveLength(1);
    expect(first[0].holes).toHaveLength(1);
    expect(first[0]).toMatchObject({ roi_id: "parent", outline_id: "scope" });
    state = roiSessionReducer(state, { type: "review", page_id: "page-1", id: "rooflight", patch: { review_status: "accepted" } });
    expect(penetrationScopes(state.pages["page-1"])).toEqual(first);
  });
});
