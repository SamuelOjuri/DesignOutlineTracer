import { describe, expect, it } from "vitest";
import type { Box2D } from "@/types/roi";
import { boxToDisplay, boxToSource, cropBoxToPage, displayToBox, pageBoxToCrop, sourceToBox, validateBox } from "./roiCoordinates";

describe("canonical annotation coordinates", () => {
  const boxes: Box2D[] = [[0, 0, 1000, 1000], [0, 0, 10, 10], [990, 990, 1000, 1000], [250.125, 300.25, 700.875, 810.625]];
  for (const rotation of [0, 90, 180, 270]) {
    it(`round trips a non-square PDF.js viewport at ${rotation} degrees without rotating it again`, () => {
      for (const resolution of [1, 2, 4]) {
        const size = rotation % 180 === 0 ? { width: 1600 * resolution, height: 900 * resolution }
          : { width: 900 * resolution, height: 1600 * resolution };
        for (const box of boxes) {
          for (const zoom of [0.25, 1, 3.75]) {
            const transform = { scale_x: zoom, scale_y: zoom, offset_x: 317.25 - 82, offset_y: 60.5 + 19 };
            const result = displayToBox(boxToDisplay(box, size, transform), size, transform);
            result.forEach((value, index) => expect(Math.abs(value - box[index]) * (index % 2 ? size.width : size.height) / 1000).toBeLessThan(1));
          }
        }
        expect(boxToSource([0, 0, 500, 500], size)).toEqual({ x: 0, y: 0, width: size.width / 2, height: size.height / 2 });
      }
    });
  }

  it("maps padded crop coordinates into the whole page and back with fractions intact", () => {
    const page = { width: 2400, height: 1200 };
    const crop = { x: 281.5, y: 149.25, width: 700.5, height: 501.25 };
    const box: Box2D = [120.125, 55.625, 850.75, 900.25];
    const full = cropBoxToPage(box, crop, page);
    const source = boxToSource(full, page);
    expect(source.x).toBeCloseTo(crop.x + box[1] / 1000 * crop.width, 10);
    pageBoxToCrop(full, crop, page).forEach((value, index) => expect(value).toBeCloseTo(box[index], 10));
  });

  it("ignores physical drawing scale and uses only measured display transforms", () => {
    const page = { width: 1000, height: 500 };
    const transform = { scale_x: 0.7, scale_y: 0.6, offset_x: -40.5, offset_y: 220.75 };
    const first = boxToDisplay(boxes[3], { ...page, drawing_scale: 100 } as typeof page, transform);
    expect(boxToDisplay(boxes[3], { ...page, drawing_scale: 500 } as typeof page, transform)).toEqual(first);
    expect(sourceToBox(boxToSource(boxes[3], page), page)).toEqual(boxes[3]);
  });

  it.each<Box2D>([[0, 0, 0, 10], [100, 0, 50, 10], [0, -1, 10, 10], [0, 0, 1001, 10], [0, 0, NaN, 10], [0, 0, 10, Infinity]])("rejects invalid geometry %j", (...box) => {
    expect(() => validateBox(box)).toThrow();
  });

  it("rejects invalid source sizes, display scales and crops instead of clamping", () => {
    expect(() => boxToSource(boxes[0], { width: 0, height: 100 })).toThrow();
    expect(() => boxToDisplay(boxes[0], { width: 100, height: 100 }, { scale_x: 0, scale_y: 1, offset_x: 0, offset_y: 0 })).toThrow();
    expect(() => cropBoxToPage(boxes[0], { x: -1, y: 0, width: 10, height: 10 }, { width: 100, height: 100 })).toThrow();
  });
});