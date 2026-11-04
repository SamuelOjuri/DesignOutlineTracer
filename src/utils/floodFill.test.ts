import { afterEach, describe, expect, it, vi } from "vitest";
import type { Point } from "@/types/roof";
import { extractInteriorHoles, extractMultipleOutlines, floodFill } from "./floodFill";
import { rasterizeOutlinesWithHoles } from "./polygonAdjust";

afterEach(() => vi.unstubAllGlobals());

const width = 160, height = 120;
const colour: [number, number, number, number] = [37, 99, 235, 15];

function page(lines: Array<[left: number, top: number, right: number, bottom: number]>) {
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (const [left, top, right, bottom] of lines) {
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  return new ImageData(data, width, height);
}

// Two-pixel black frame whose inner face is the given pixel-edge rectangle.
const frame = (left: number, top: number, right: number, bottom: number): Array<[number, number, number, number]> => [
  [left - 2, top - 2, right + 2, top], [left - 2, bottom, right + 2, bottom + 2],
  [left - 2, top, left, bottom], [right, top, right + 2, bottom],
];

const bounds = (points: Point[]) => ({
  left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
  top: Math.min(...points.map(point => point.y)), bottom: Math.max(...points.map(point => point.y)),
});

describe("Select outline extraction", () => {
  it("keeps the outline on the selected fill edge instead of growing onto the drawn boundary", () => {
    const fill = floodFill(page(frame(20, 20, 140, 100)), 60, 60, colour, undefined, 45, true);
    const outlines = extractMultipleOutlines(fill.filledMask, width, height);
    expect(outlines).toHaveLength(1);
    expect(bounds(outlines[0])).toEqual({ left: 20, top: 20, right: 140, bottom: 100 });
    expect(rasterizeOutlinesWithHoles(outlines, [], width, height)).toEqual(fill.filledMask);
  });

  it("does not grow a saved outline when its mask is rebuilt and extracted again", () => {
    const fill = floodFill(page(frame(20, 20, 140, 100)), 60, 60, colour, undefined, 45, true);
    let outlines = extractMultipleOutlines(fill.filledMask, width, height);
    const saved = outlines;
    for (let round = 0; round < 3; round++) {
      outlines = extractMultipleOutlines(rasterizeOutlinesWithHoles(outlines, [], width, height), width, height);
    }
    expect(outlines).toEqual(saved);
  });

  it("still merges fills on both sides of a thin internal line into one outer boundary", () => {
    const image = page([...frame(20, 20, 140, 100), [79, 20, 81, 100]]);
    const first = floodFill(image, 40, 60, colour, undefined, 45, true);
    const both = floodFill(image, 120, 60, colour, first.filledMask, 45, true);
    const outlines = extractMultipleOutlines(both.filledMask, width, height);
    expect(outlines).toHaveLength(1);
    expect(bounds(outlines[0])).toEqual({ left: 20, top: 20, right: 140, bottom: 100 });
    expect(extractInteriorHoles(both.filledMask, width, height)).toEqual([]);
  });

  it("keeps a penetration hole at its drawn size", () => {
    // The penetration's outer face spans x 60..111 and y 40..81.
    const fill = floodFill(page([...frame(20, 20, 140, 100), ...frame(62, 42, 109, 79)]), 30, 30, colour, undefined, 45, true);
    const outlines = extractMultipleOutlines(fill.filledMask, width, height);
    const holes = extractInteriorHoles(fill.filledMask, width, height);
    expect(holes).toHaveLength(1);
    expect(bounds(holes[0])).toEqual({ left: 60, top: 40, right: 111, bottom: 81 });
    expect(rasterizeOutlinesWithHoles(outlines, holes, width, height)).toEqual(fill.filledMask);
  });
});
