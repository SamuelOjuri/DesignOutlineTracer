import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { rasterizeOutlinesWithHoles } from "@/utils/polygonAdjust";
import { buildRoiFillMask } from "@/utils/roiFillMask";
import * as floodFill from "@/utils/floodFill";
import type { Point } from "@/types/roof";
import type { RoiAnnotation } from "@/types/roi";
import { PaintBucketCanvas } from "./PaintBucketCanvas";

afterEach(() => vi.unstubAllGlobals());

it("uses the chosen sensitivity for preview and cutting without changing geometry when the slider moves", async () => {
  const width = 100, height = 80;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  // Two connected, subtly different roof surfaces: low tolerance should separate them.
  for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) {
    data.fill(245, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  const writes = vi.fn();
  Object.assign(mockCanvasContext(), {
    getImageData: () => ({ data, width, height }),
    putImageData: writes,
    createImageData: () => ({ data: new Uint8ClampedArray(data.length), width, height }),
  });
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const onOutlinesExtracted = vi.fn();
  render(<PaintBucketCanvas pdfCanvas={source} onOutlinesExtracted={onOutlinesExtracted}
    roofOutlines={[[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 70 }, { x: 10, y: 70 }]]} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Cut Out" })).toBeEnabled());
  expect(screen.getByRole("slider", { name: "Selection sensitivity" })).toHaveValue("45");
  fireEvent.click(screen.getByRole("button", { name: "Cut Out" }));
  const slider = screen.getByRole("slider", { name: "Cut Out sensitivity" });
  expect(slider).toHaveValue("40");
  const canvas = screen.getByTestId("paint-interaction-canvas") as HTMLCanvasElement;
  const position = { clientX: 25 * parseFloat(canvas.style.width) / width,
    clientY: 40 * parseFloat(canvas.style.height) / height };
  const previewCount = () => {
    const frame = writes.mock.calls.at(-1)?.[0] as ImageData | undefined;
    if (!frame) return 0;
    let count = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      if (frame.data[i] === 255 && frame.data[i + 1] === 140 && frame.data[i + 2] === 0 && frame.data[i + 3] === 100) count++;
    }
    return count;
  };
  fireEvent.mouseMove(canvas, position);
  await waitFor(() => expect(previewCount()).toBeGreaterThan(4000));
  const broadPreview = previewCount();
  fireEvent.change(slider, { target: { value: "10" } });
  writes.mockClear();
  // Returning to exactly the same pixel must recompute at the new tolerance.
  fireEvent.mouseMove(canvas, position);
  await waitFor(() => expect(previewCount()).toBeGreaterThan(0));
  expect(previewCount()).toBeLessThan(broadPreview);
  expect(onOutlinesExtracted).not.toHaveBeenCalled();
  fireEvent.click(canvas, position);
  const remaining = rasterizeOutlinesWithHoles(onOutlinesExtracted.mock.lastCall![0], [], width, height);
  expect(remaining[40 * width + 25]).toBe(0);
  expect(remaining[40 * width + 75]).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getByRole("button", { name: "Cut Out" }));
  expect(screen.getByRole("slider", { name: "Cut Out sensitivity" })).toHaveValue("10");
  const edits = onOutlinesExtracted.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Default (40)" }));
  expect(screen.getByRole("slider", { name: "Cut Out sensitivity" })).toHaveValue("40");
  expect(onOutlinesExtracted).toHaveBeenCalledTimes(edits);
});

async function setupSelection(roofOutlines: Point[][] = [], interiorHoles: Point[][] = [], acceptedRegions: RoiAnnotation[] = []) {
  vi.stubGlobal("ImageData", class {
    constructor(public data: Uint8ClampedArray, public width: number, public height: number) {}
  });
  const width = 120, height = 100;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let row = 0; row < height; row++) for (let column = 0; column < width / 2; column++) {
    data.fill(215, (row * width + column) * 4, (row * width + column) * 4 + 3);
  }
  const writes = vi.fn();
  const context = Object.assign(mockCanvasContext(), {
    getImageData: () => ({ data, width, height }),
    putImageData: writes,
    createImageData: () => ({ data: new Uint8ClampedArray(data.length), width, height }),
  });
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const onOutlinesExtracted = vi.fn<(outlines: Point[][]) => void>();
  const onHolesExtracted = vi.fn<(holes: Point[][]) => void>();
  function Editor() {
    const [outlines, setOutlines] = useState(roofOutlines);
    const [holes, setHoles] = useState(interiorHoles);
    return <PaintBucketCanvas pdfCanvas={source} roofOutlines={outlines} interiorHoles={holes}
      acceptedRegions={acceptedRegions}
      onOutlinesExtracted={(next) => { onOutlinesExtracted(next); setOutlines(next); }}
      onHolesExtracted={(next) => { onHolesExtracted(next); setHoles(next); }} />;
  }
  render(<Editor />);
  const slider = screen.getByRole("slider", { name: "Selection sensitivity" });
  expect(slider).toBeDisabled();
  await waitFor(() => expect(slider).toBeEnabled());
  const canvas = screen.getByTestId("paint-interaction-canvas") as HTMLCanvasElement;
  const position = (column: number, row: number) => ({
    clientX: column * parseFloat(canvas.style.width) / width,
    clientY: row * parseFloat(canvas.style.height) / height,
  });
  const previewMask = () => {
    const frame = writes.mock.lastCall?.[0] as ImageData | undefined;
    return Uint8Array.from({ length: width * height }, (_, pixel) =>
      frame?.data[pixel * 4] === 50 && frame.data[pixel * 4 + 3] === 100 ? 1 : 0);
  };
  const selectedMask = () => rasterizeOutlinesWithHoles(
    onOutlinesExtracted.mock.lastCall![0], onHolesExtracted.mock.lastCall![0], width, height
  );
  return { width, height, slider, canvas, position, previewMask, selectedMask, writes, context,
    onOutlinesExtracted, onHolesExtracted };
}

it("uses selection sensitivity for hover and click without changing existing geometry or zoom", async () => {
  const { width, slider, canvas, position, previewMask, selectedMask, writes, context,
    onOutlinesExtracted, onHolesExtracted } = await setupSelection();
  expect(slider).toHaveValue("45");
  expect(screen.getByRole("button", { name: "Default (45)" })).toBeDisabled();
  fireEvent.click(screen.getByTitle("Zoom out"));
  const canvasWidth = canvas.style.width;
  fireEvent.mouseMove(canvas, position(25, 50));
  await waitFor(() => expect(previewMask()[50 * width + 95]).toBe(1));
  fireEvent.change(slider, { target: { value: "10" } });
  writes.mockClear();
  fireEvent.mouseMove(canvas, position(25, 50));
  await waitFor(() => expect(previewMask()[50 * width + 25]).toBe(1));
  expect(previewMask()[50 * width + 95]).toBe(0);
  expect(onOutlinesExtracted).not.toHaveBeenCalled();
  expect(onHolesExtracted).not.toHaveBeenCalled();
  expect(canvas.style.width).toBe(canvasWidth);
  expect(context.drawImage).toHaveBeenCalledTimes(1);

  fireEvent.mouseDown(canvas, { ...position(25, 50), button: 0 });
  fireEvent.mouseUp(canvas, position(25, 50));
  const selected = selectedMask();
  expect(selected[50 * width + 25]).toBe(1);
  expect(selected[50 * width + 95]).toBe(0);

  const edits = onOutlinesExtracted.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Cut Out" }));
  expect(screen.queryByRole("slider", { name: "Selection sensitivity" })).not.toBeInTheDocument();
  expect(screen.getByRole("slider", { name: "Cut Out sensitivity" })).toHaveValue("40");
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  expect(screen.getByRole("slider", { name: "Selection sensitivity" })).toHaveValue("10");
  fireEvent.click(screen.getByRole("button", { name: "Default (45)" }));
  expect(screen.getByRole("slider", { name: "Selection sensitivity" })).toHaveValue("45");
  expect(onOutlinesExtracted).toHaveBeenCalledTimes(edits);
  expect(canvas.style.width).toBe(canvasWidth);
  expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onOutlinesExtracted.mock.lastCall![0]).toEqual([]);
  expect(onHolesExtracted.mock.lastCall![0]).toEqual([]);

  fireEvent.mouseDown(canvas, { ...position(25, 50), button: 0 });
  fireEvent.mouseUp(canvas, position(25, 50));
  expect(selectedMask()[50 * width + 95]).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cut Out rectangle" }));
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
});

it("refreshes drag previews and commits at the current sensitivity without resetting undo or rebuilding source edges", async () => {
  const regions = vi.spyOn(floodFill, "buildRegionMap");
  const edges = vi.spyOn(floodFill, "buildEdgeMap");
  const { width, slider, canvas, position, previewMask, selectedMask, onOutlinesExtracted } = await setupSelection();
  fireEvent.change(slider, { target: { value: "10" } });
  expect(regions).not.toHaveBeenCalled();
  fireEvent.mouseDown(canvas, { ...position(25, 30), button: 0 });
  fireEvent.mouseMove(canvas, position(35, 50));
  expect(previewMask()[50 * width + 25]).toBe(1);
  expect(previewMask()[50 * width + 95]).toBe(0);
  fireEvent.mouseUp(canvas);
  expect(selectedMask()[50 * width + 25]).toBe(1);
  expect(selectedMask()[50 * width + 95]).toBe(0);
  expect(regions).toHaveBeenCalledTimes(1);

  fireEvent.change(slider, { target: { value: "100" } });
  expect(onOutlinesExtracted).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onOutlinesExtracted.mock.lastCall![0]).toEqual([]);
  fireEvent.mouseDown(canvas, { ...position(25, 30), button: 0 });
  fireEvent.mouseMove(canvas, position(35, 50));
  expect(previewMask()[50 * width + 95]).toBe(1);
  fireEvent.mouseMove(canvas, position(40, 55));
  fireEvent.mouseUp(canvas);
  expect(selectedMask()[50 * width + 95]).toBe(1);
  expect(regions.mock.calls.map(call => call[4])).toEqual([10, 100]);
  expect(edges).toHaveBeenCalledTimes(1);
});

it.each(["click", "drag"])("preserves ROI boundaries and existing cutouts at maximum sensitivity during %s selection", async (mode) => {
  const extraction = vi.spyOn(floodFill, "extractMultipleOutlines");
  const outlines = [[{ x: 16, y: 12 }, { x: 75, y: 12 }, { x: 75, y: 88 }, { x: 16, y: 88 }]];
  const holes = [[{ x: 22, y: 22 }, { x: 68, y: 22 }, { x: 68, y: 78 }, { x: 22, y: 78 }]];
  const region: RoiAnnotation = {
    id: "roof", page_id: "page", kind: "roof_roi", label: "Roof",
    box_2d: [100, 100, 900, 900], proposed_box_2d: [100, 100, 900, 900],
    roi_id: null, origin: "manual", review_status: "accepted", validity: "current",
    revision: 0, edits: [], warnings: [],
  };
  const { width, height, slider, canvas, position, previewMask, selectedMask,
    onOutlinesExtracted, onHolesExtracted } = await setupSelection(outlines, holes, [region]);
  fireEvent.change(slider, { target: { value: "100" } });
  expect(onOutlinesExtracted).not.toHaveBeenCalled();
  expect(onHolesExtracted).not.toHaveBeenCalled();
  const allowed = buildRoiFillMask([region.box_2d], { width, height })!;
  if (mode === "click") {
    fireEvent.mouseMove(canvas, position(80, 60));
    await waitFor(() => expect(previewMask()[60 * width + 80]).toBe(1));
  } else {
    fireEvent.mouseDown(canvas, { ...position(80, 60), button: 0 });
    fireEvent.mouseMove(canvas, position(95, 75));
  }
  expect(previewMask().some((value, pixel) => value !== 0 && !allowed[pixel])).toBe(false);
  expect(previewMask()[50 * width + 35]).toBe(0);
  if (mode === "click") fireEvent.mouseDown(canvas, { ...position(80, 60), button: 0 });
  fireEvent.mouseUp(canvas);
  expect(selectedMask()[60 * width + 80]).toBe(1);
  expect(selectedMask()[50 * width + 35]).toBe(0);
  const committedMask = extraction.mock.lastCall![0];
  expect(committedMask.some((value, pixel) => value !== 0 && !allowed[pixel])).toBe(false);
  expect(committedMask[50 * width + 35]).toBe(0);
  expect(onOutlinesExtracted.mock.lastCall![0].flat().every(point =>
    point.x >= width * 0.1 && point.x <= width * 0.9 && point.y >= height * 0.1 && point.y <= height * 0.9
  )).toBe(true);
  fireEvent.change(slider, { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(onOutlinesExtracted.mock.lastCall![0]).toEqual(outlines);
  expect(onHolesExtracted.mock.lastCall![0]).toEqual(holes);
});
