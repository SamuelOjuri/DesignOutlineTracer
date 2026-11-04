import { describe, expect, it } from "vitest";
import type { PagePolygon, PageSession, RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { nextRegionToOutline, outlinedRegionIds, preferredOutlineTarget } from "./outlineCoverage";

// The synthetic page is 800 x 600 px, so box_2d [top, left, bottom, right] / 1000 maps to x * 0.8 and y * 0.6.
const west = syntheticAnnotation("west", { box_2d: [100, 100, 500, 400] }); // x 80-320, y 60-300
const east = syntheticAnnotation("east", { box_2d: [100, 500, 500, 900] }); // x 400-720, y 60-300
const south = syntheticAnnotation("south", { box_2d: [600, 100, 900, 900] }); // x 80-720, y 360-540
const rect = (x1: number, y1: number, x2: number, y2: number): Point[] =>
  [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];

function page(outlines: Partial<PagePolygon>[], annotations: RoiAnnotation[] = [west, east, south]): PageSession {
  return { source: syntheticPage(), annotations, roi_revision: 1, geometry_revision: 0, revision: 0, pending: {},
    used_request_ids: [], runs: [], history: [],
    drawing: { outlines: outlines.map((outline, index) => ({ id: `outline-${index}`, page_id: "page-1", roi_id: null,
      points: [], ...outline })), holes: [], outlets: [], drainage_edges: [], drawing_scale: { paperSize: "A1", scaleRatio: 50 } } };
}

describe("outline coverage", () => {
  it("attributes generated outlines by roof area and manual or orphaned outlines by their centre", () => {
    expect(outlinedRegionIds(page([]))).toEqual(new Set());
    // A generated outline belongs to its region even when its centre lies in another box.
    expect(outlinedRegionIds(page([{ roi_id: "east", points: rect(100, 100, 300, 200) }]))).toEqual(new Set(["east"]));
    expect(outlinedRegionIds(page([{ points: rect(100, 100, 300, 200) }]))).toEqual(new Set(["west"]));
    expect(outlinedRegionIds(page([{ roi_id: "deleted-roi", points: rect(450, 380, 650, 500) }]))).toEqual(new Set(["south"]));
    // A concave manual outline is attributed by its area centroid.
    const lShape = [{ x: 410, y: 70 }, { x: 710, y: 70 }, { x: 710, y: 290 }, { x: 610, y: 290 }, { x: 610, y: 170 }, { x: 410, y: 170 }];
    expect(outlinedRegionIds(page([{ points: lShape }]))).toEqual(new Set(["east"]));
    expect(outlinedRegionIds(page([{ points: rect(100, 100, 300, 200).slice(0, 2) }]))).toEqual(new Set());
  });

  it("ignores roof areas that are not accepted and current", () => {
    const rejected = { ...east, review_status: "rejected" as const };
    const stale = { ...south, validity: "needs_review" as const };
    const session = page([{ roi_id: "east", points: rect(450, 100, 650, 200) }, { points: rect(450, 380, 650, 500) }],
      [west, rejected, stale]);
    expect(outlinedRegionIds(session)).toEqual(new Set());
    expect(nextRegionToOutline(session, null)).toBe("west");
  });

  it("advances to the next roof area that still needs an outline, wrapping in display order", () => {
    const eastDone = page([{ roi_id: "east", points: rect(450, 100, 650, 200) }]);
    expect(nextRegionToOutline(eastDone, "east")).toBe("south");
    expect(nextRegionToOutline(page([{ roi_id: "south", points: rect(450, 380, 650, 500) }]), "south")).toBe("west");
    expect(nextRegionToOutline(eastDone, null)).toBe("west");
    const allDone = page([{ points: rect(100, 100, 300, 200) }, { points: rect(450, 100, 650, 200) },
      { points: rect(450, 380, 650, 500) }]);
    expect(nextRegionToOutline(allDone, "east")).toBeNull();
  });

  it("keeps a chosen roof area that needs an outline and otherwise moves on", () => {
    const westDone = page([{ points: rect(100, 100, 300, 200) }]);
    expect(preferredOutlineTarget(westDone, "south")).toBe("south");
    expect(preferredOutlineTarget(westDone, "west")).toBe("east");
    expect(preferredOutlineTarget(westDone, null)).toBe("east");
    expect(preferredOutlineTarget(westDone, "unknown")).toBe("east");
    const allDone = page([{ points: rect(100, 100, 300, 200) }, { points: rect(450, 100, 650, 200) },
      { points: rect(450, 380, 650, 500) }]);
    expect(preferredOutlineTarget(allDone, "south")).toBe("south");
    expect(preferredOutlineTarget(page([], []), "west")).toBeNull();
  });
});
