import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { rasterizeOutlinesWithHoles } from "@/utils/polygonAdjust";
import { PaintBucketCanvas } from "./PaintBucketCanvas";

vi.mock("@/utils/floodFill", () => ({
  buildEdgeMap: () => new Uint8Array(80),
  buildRegionMap: () => ({ regionLabels: new Int32Array(80), regionSeeds: new Map() }),
}));
vi.mock("@/utils/polygonAdjust", () => ({ rasterizeOutlinesWithHoles: vi.fn(() => new Uint8Array(80).fill(1)) }));

beforeEach(() => {
  const context = mockCanvasContext();
  Object.assign(context, {
    getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(320), width: 10, height: 8 })),
    putImageData: vi.fn(),
    createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(320), width: 10, height: 8 })),
  });
});

it("restores manual roof and cutout masks without emitting geometry or mutating the PDF source", async () => {
  const source = document.createElement("canvas");
  source.width = 10;
  source.height = 8;
  const outlines = [[{ x: 1, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 7 }]];
  const holes = [[{ x: 4, y: 2 }, { x: 5, y: 2 }, { x: 5, y: 3 }]];
  const onOutlinesExtracted = vi.fn();
  const onHolesExtracted = vi.fn();
  render(<PaintBucketCanvas pdfCanvas={source} roofOutlines={outlines} interiorHoles={holes}
    onOutlinesExtracted={onOutlinesExtracted} onHolesExtracted={onHolesExtracted} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Select" })).toBeEnabled());
  expect(rasterizeOutlinesWithHoles).toHaveBeenCalledWith(outlines, holes, 10, 8);
  expect(rasterizeOutlinesWithHoles).toHaveBeenCalledWith(holes, [], 10, 8);
  expect(onOutlinesExtracted).not.toHaveBeenCalled();
  expect(onHolesExtracted).not.toHaveBeenCalled();
  expect(source.width).toBe(10);
});