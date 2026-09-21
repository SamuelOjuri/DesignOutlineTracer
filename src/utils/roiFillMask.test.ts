import { afterEach, describe, expect, it, vi } from "vitest";
import { buildRoiFillMask } from "./roiFillMask";
import { buildEdgeMap, buildRegionMap, extractInteriorHoles, extractMultipleOutlines, floodFill, floodFillPreview } from "./floodFill";

afterEach(() => vi.unstubAllGlobals());

const width = 120, height = 100;
const colour: [number, number, number, number] = [220, 50, 50, 160];

function whitePage() {
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  return new ImageData(new Uint8ClampedArray(width * height * 4).fill(255), width, height);
}

function expectInside(mask: Uint8Array, allowed: Uint8Array) {
  expect(mask.some((value, i) => value !== 0 && !allowed[i])).toBe(false);
}

describe("ROI-constrained flood fill", () => {
  it("maps fractional normalized coordinates to whole source pixels and supports multiple regions", () => {
    const mask = buildRoiFillMask([[105, 205, 795, 805], [0, 0, 100, 100]], { width: 100, height: 100 })!;
    expect(mask[11 * 100 + 21]).toBe(1);
    expect(mask[10 * 100 + 21]).toBe(0);
    expect(mask[11 * 100 + 20]).toBe(0);
    expect(mask[78 * 100 + 79]).toBe(1);
    expect(mask[79 * 100 + 79]).toBe(0);
    expect(mask[78 * 100 + 80]).toBe(0);
    expect(mask[0]).toBe(1);
    expect(mask.reduce((sum, value) => sum + value, 0)).toBe(68 * 59 + 100);
  });

  it("keeps preview and final fill inside an ROI even when the drawing has no boundary", () => {
    const page = whitePage();
    const allowed = buildRoiFillMask([[200, 250, 800, 750]], page)!;
    const original = page.data.slice();
    const edgeMap = buildEdgeMap(page.data, width, height);
    const preview = floodFillPreview(page.data, width, height, 40, 40, edgeMap, undefined, 45, allowed);
    const fill = floodFill(page, 40, 40, colour, undefined, 45, true, allowed);
    expect(preview.filledPixelCount).toBe(3600);
    expect(fill.filledMask).toEqual(preview.filledMask);
    expectInside(fill.filledMask, allowed);
    expect(page.data).toEqual(original);
    const outlines = extractMultipleOutlines(fill.filledMask, width, height, allowed);
    expect(outlines).toHaveLength(1);
    expect(outlines[0].every(({ x, y }) => x >= 30 && x <= 90 && y >= 20 && y <= 80)).toBe(true);
    expect(extractInteriorHoles(fill.filledMask, width, height, 200, allowed)).toEqual([]);
  });

  it("prevents a fill from escaping and re-entering on the other side of a wall", () => {
    const page = whitePage();
    const allowed = buildRoiFillMask([[200, 250, 800, 750]], page)!;
    for (let y = 20; y < 80; y++) for (let x = 59; x <= 61; x++) {
      page.data.fill(0, (y * width + x) * 4, (y * width + x) * 4 + 3);
    }
    const edgeMap = buildEdgeMap(page.data, width, height);
    const preview = floodFillPreview(page.data, width, height, 40, 40, edgeMap, undefined, 45, allowed);
    const fill = floodFill(page, 40, 40, colour, undefined, 45, true, allowed);
    expect(fill.filledMask).toEqual(preview.filledMask);
    expect(fill.filledMask[40 * width + 75]).toBe(0);
    expect(fill.filledMask[40 * width + 40]).toBe(1);
    const regions = buildRegionMap(page.data, width, height, edgeMap, 45, allowed);
    expect(regions.regionLabels[40 * width + 40]).not.toBe(regions.regionLabels[40 * width + 75]);
    expect(regions.regionLabels[0]).toBe(-1);
  });

  it("does nothing for an outside seed in preview and final selection", () => {
    const page = whitePage();
    const allowed = buildRoiFillMask([[200, 250, 800, 750]], page)!;
    const fill = floodFill(page, 5, 5, colour, undefined, 45, true, allowed);
    const preview = floodFillPreview(page.data, width, height, 5, 5, buildEdgeMap(page.data, width, height), undefined, 45, allowed);
    expect(fill.filledPixelCount).toBe(0);
    expect(preview.filledPixelCount).toBe(0);
    expect(fill.filledMask.some(Boolean)).toBe(false);
    expect(preview.filledMask.some(Boolean)).toBe(false);
  });

  it("keeps separate ROIs disconnected, including during drag selection and outline expansion", () => {
    const page = whitePage();
    const allowed = buildRoiFillMask([[100, 100, 900, 480], [100, 520, 900, 900]], page)!;
    const fill = floodFill(page, 20, 20, colour, undefined, 45, true, allowed);
    expect(fill.filledMask[20 * width + 80]).toBe(0);
    const second = floodFill(page, 80, 20, colour, fill.filledMask, 45, true, allowed);
    expect(second.filledMask[20 * width + 20]).toBe(1);
    expect(second.filledMask[20 * width + 80]).toBe(1);
    const regions = buildRegionMap(page.data, width, height, buildEdgeMap(page.data, width, height), 45, allowed);
    expect(regions.regionSeeds.size).toBe(2);
    expect(regions.regionLabels[20 * width + 20]).not.toBe(regions.regionLabels[20 * width + 80]);
    const dragMask = Uint8Array.from(regions.regionLabels, label => regions.regionSeeds.has(label) ? 1 : 0);
    expectInside(dragMask, allowed);
    expect(extractMultipleOutlines(second.filledMask, width, height, allowed)).toHaveLength(2);
  });

  it("constrains optional fill cleanup as well as scanline traversal", () => {
    const page = whitePage();
    const allowed = buildRoiFillMask([[200, 250, 800, 750]], page)!;
    const fill = floodFill(page, 40, 40, colour, undefined, 45, false, allowed);
    expectInside(fill.filledMask, allowed);
    expect(fill.filledPixelCount).toBeGreaterThan(500);
  });

  it("keeps manual full-page filling available when there are no accepted ROIs", () => {
    const page = whitePage();
    const allowed = buildRoiFillMask([], page);
    expect(allowed).toBeUndefined();
    expect(floodFill(page, 5, 5, colour, undefined, 45, true, allowed).filledPixelCount).toBe(width * height);
  });
});
