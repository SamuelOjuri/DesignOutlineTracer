import { describe, expect, it } from "vitest";
import { drawnRoiBox, editRoiBox } from "./roiBoxEditing";
import { validateBox } from "./roiCoordinates";

describe("ROI box editing", () => {
  it("preserves fractions and box size when movement meets a page edge", () => {
    expect(editRoiBox([100.25, 200.5, 400.75, 600.5], { x: 900, y: -900 }, "move"))
      .toEqual([0, 600, 300.5, 1000]);
  });
  it.each(["nw", "ne", "sw", "se"] as const)("keeps %s resizing nonzero and inside the page", (handle) => {
    for (const delta of [{ x: 2000, y: 2000 }, { x: -2000, y: -2000 }]) {
      expect(() => validateBox(editRoiBox([100, 200, 400, 600], delta, handle))).not.toThrow();
    }
  });
  it("normalizes a box drawn in reverse without rounding", () => {
    expect(drawnRoiBox({ x: 800.5, y: 600 }, { x: 200, y: 100.25 })).toEqual([100.25, 200, 600, 800.5]);
  });
});