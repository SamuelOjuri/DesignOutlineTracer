import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { steppedRoof, trimmedRoof, trimmedRoofWithNotch } from "@/test/roofBoundary";
import { rasterizeOutlinesWithHoles } from "@/utils/polygonAdjust";
import type { Point } from "@/types/roof";
import { PaintBucketCanvas } from "./PaintBucketCanvas";

vi.mock("@/utils/floodFill", () => ({
  buildEdgeMap: () => new Uint8Array(80),
  buildRegionMap: () => ({ regionLabels: new Int32Array(80), regionSeeds: new Map() }),
}));
vi.mock("@/utils/polygonAdjust", async importOriginal => {
  const actual = await importOriginal<typeof import("@/utils/polygonAdjust")>();
  return { ...actual, rasterizeOutlinesWithHoles: vi.fn(actual.rasterizeOutlinesWithHoles) };
});

afterEach(() => vi.unstubAllGlobals());

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

const roof: Point[] = [{ x: 40, y: 40 }, { x: 200, y: 40 }, { x: 202, y: 160 }, { x: 200, y: 260 }, { x: 40, y: 260 }];
const otherRoof: Point[] = [{ x: 280, y: 40 }, { x: 360, y: 40 }, { x: 360, y: 260 }, { x: 280, y: 260 }];
const cutout: Point[] = [{ x: 60, y: 80 }, { x: 90, y: 80 }, { x: 90, y: 110 }, { x: 60, y: 110 }];

async function adjustmentEditor(outlines = [roof, otherRoof], holes = [cutout]) {
  const context = mockCanvasContext();
  const width = 400, height = 300;
  Object.assign(context, {
    getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData: vi.fn(),
    createImageData: (imageWidth: number, imageHeight: number) => ({ data: new Uint8ClampedArray(imageWidth * imageHeight * 4), width: imageWidth, height: imageHeight }),
  });
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  const captured = new Set<number>();
  Object.assign(HTMLCanvasElement.prototype, {
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  });
  const source = document.createElement("canvas");
  source.width = width; source.height = height;
  const outlinesChanged = vi.fn(), holesChanged = vi.fn();
  function Editor() {
    const [currentOutlines, setOutlines] = useState(outlines);
    const [currentHoles, setHoles] = useState(holes);
    return <PaintBucketCanvas pdfCanvas={source} roofOutlines={currentOutlines} interiorHoles={currentHoles}
      onOutlinesExtracted={(next, index) => { outlinesChanged(next, index); setOutlines(next); }}
      onHolesExtracted={next => { holesChanged(next); setHoles(next); }} />;
  }
  render(<Editor />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Adjust" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
  const canvas = screen.getByTestId("paint-interaction-canvas") as HTMLCanvasElement;
  const event = (type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number, shiftKey = false) => {
    const bounds = screen.getByTestId("paint-source-canvas").getBoundingClientRect();
    const scale = parseFloat(canvas.style.width) / width;
    fireEvent[type](canvas, { pointerId: 7, button: 0, clientX: bounds.left + x * scale, clientY: bounds.top + y * scale, shiftKey });
  };
  return { canvas, event, context, outlinesChanged, holesChanged };
}

it("highlights a merge at zoom, commits only on release and restores points and cutouts with one undo", async () => {
  const { canvas, event, context, outlinesChanged, holesChanged } = await adjustmentEditor();
  fireEvent.click(screen.getByTitle("Zoom in"));
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: -80, top: -40 } as DOMRect);
  event("pointerDown", 202, 160);
  event("pointerMove", 203, 42);
  expect(screen.getByRole("status")).toHaveTextContent("Merge vertex");
  expect(context.arc).toHaveBeenCalledWith(200, 40, 11 / (parseFloat(canvas.style.width) / 400), 0, Math.PI * 2);
  expect(outlinesChanged).not.toHaveBeenCalled();
  fireEvent.mouseLeave(canvas);
  expect(outlinesChanged).not.toHaveBeenCalled();
  event("pointerUp", 203, 42);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged).toHaveBeenLastCalledWith([roof.filter((_, index) => index !== 2), otherRoof], 0);
  expect(holesChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged.mock.lastCall![0]).toEqual([roof, otherRoof]);
  expect(holesChanged).toHaveBeenLastCalledWith([cutout]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("straightens a multi-point side separately from merging, preserves cutouts and ignores an already straight side", async () => {
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor();
  fireEvent.click(screen.getByRole("button", { name: "Straighten" }));
  event("pointerDown", 201, 100);
  event("pointerUp", 201, 100);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  const expected = roof.map((point, index) => index === 2 ? { ...point, x: 200 } : point);
  expect(outlinesChanged).toHaveBeenLastCalledWith([expected, otherRoof], 0);
  expect(holesChanged).not.toHaveBeenCalled();
  event("pointerDown", 200, 100);
  event("pointerUp", 200, 100);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged.mock.lastCall![0]).toEqual([roof, otherRoof]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it.each(["Escape", "blur", "tool", "capture", "cancel", "zoom"])("cancels an adjustment on %s without saving or adding undo", async action => {
  const { canvas, event, outlinesChanged } = await adjustmentEditor();
  event("pointerDown", 202, 160);
  event("pointerMove", 200, 40);
  if (action === "Escape") fireEvent.keyDown(window, { key: "Escape" });
  if (action === "blur") fireEvent.blur(window);
  if (action === "tool") fireEvent.click(screen.getByRole("button", { name: "Straighten" }));
  if (action === "capture") fireEvent.lostPointerCapture(canvas, { pointerId: 7 });
  if (action === "cancel") fireEvent.pointerCancel(canvas, { pointerId: 7 });
  if (action === "zoom") fireEvent.click(screen.getByTitle("Zoom in"));
  event("pointerUp", 200, 40);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("rejects crossed outlines, merges with other roofs, collapsed Shift alignment and clicks without movement", async () => {
  const { event, outlinesChanged } = await adjustmentEditor();
  for (const [start, end, shift] of [
    [[202, 160], [280, 40], false],
    [[40, 40], [202, 160], false],
    [[202, 160], [200, 40], true],
    [[202, 160], [202, 160], false],
  ] as const) {
    event("pointerDown", start[0], start[1]);
    event("pointerUp", end[0], end[1], shift);
  }
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("still aligns valid corners with Shift and moves edges without losing cutouts", async () => {
  const rectangle = roof.filter((_, index) => index !== 2);
  const skewed = rectangle.map((point, index) => index === 1 ? { x: 202, y: 42 } : point);
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor([skewed]);
  event("pointerDown", 202, 42);
  event("pointerUp", 201, 40, true);
  expect(outlinesChanged).toHaveBeenLastCalledWith([rectangle], 0);
  event("pointerDown", 200, 160);
  event("pointerUp", 220, 160);
  expect(outlinesChanged.mock.lastCall![0][0].filter((point: Point) => point.x === 220)).toHaveLength(2);
  expect(holesChanged).not.toHaveBeenCalled();
});

it.each(["outside", "partial"])("shrinks the scope with an %s cutout, previews without saving and undoes outlines and cutouts together", async mode => {
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor();
  const endY = mode === "outside" ? 130 : 95;
  event("pointerDown", 120, 40);
  event("pointerMove", 120, endY);
  expect(screen.getByRole("status")).not.toHaveTextContent("blocked");
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(holesChanged).not.toHaveBeenCalled();
  event("pointerUp", 120, endY);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(holesChanged).toHaveBeenLastCalledWith([]);
  const result = outlinesChanged.mock.lastCall![0] as Point[][];
  expect(result[1]).toEqual(otherRoof);
  expect(Math.min(...result[0].map(point => point.y))).toBe(endY);
  const mask = rasterizeOutlinesWithHoles(result, holesChanged.mock.lastCall![0], 400, 300);
  expect(mask[100 * 400 + 75]).toBe(0);
  expect(mask[200 * 400 + 120]).toBe(1);
  if (mode === "partial") {
    expect(result[0]).toContainEqual({ x: 60, y: 95 });
    expect(result[0]).toContainEqual({ x: 90, y: 110 });
    expect(mask[100 * 400 + 120]).toBe(1);
  }
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged.mock.lastCall![0]).toEqual([roof, otherRoof]);
  expect(holesChanged.mock.lastCall![0]).toEqual([cutout]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("cancels cutout reconciliation without changing geometry or adding undo", async () => {
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor();
  event("pointerDown", 120, 40);
  event("pointerMove", 120, 130);
  fireEvent.keyDown(window, { key: "Escape" });
  event("pointerUp", 120, 130);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("repairs the inherited retraced return when reducing scope and Undo restores the original points", async () => {
  const retraced = [{ x: 40, y: 40 }, { x: 200, y: 40 }, { x: 200, y: 170 },
    { x: 200, y: 140 }, { x: 190, y: 140 }, { x: 190, y: 260 }, { x: 40, y: 260 }];
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor([retraced]);
  event("pointerDown", 120, 40);
  event("pointerUp", 120, 130);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(holesChanged).toHaveBeenLastCalledWith([]);
  expect(outlinesChanged.mock.lastCall![0][0]).not.toContainEqual({ x: 200, y: 170 });
  expect(screen.getByRole("status")).toHaveTextContent("Existing boundary defects repaired");
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged.mock.lastCall![0]).toEqual([retraced]);
  expect(holesChanged.mock.lastCall![0]).toEqual([cutout]);
});

it("reports the specific roof collision without committing or adding undo", async () => {
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor();
  event("pointerDown", 202, 160);
  event("pointerUp", 280, 150);
  expect(screen.getByRole("status")).toHaveTextContent("touch or overlap roof area 2");
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it.each([true, false])("trims the narrow return in two reversible edge drags at zoom, top first: %s", async topFirst => {
  const neighbour = [{ x: 330, y: 40 }, { x: 380, y: 40 }, { x: 380, y: 270 }, { x: 330, y: 270 }];
  const inside = [{ x: 200, y: 150 }, { x: 220, y: 150 }, { x: 220, y: 170 }, { x: 200, y: 170 }];
  const partial = [{ x: 220, y: 90 }, { x: 240, y: 90 }, { x: 240, y: 115 }, { x: 220, y: 115 }];
  const outside = [{ x: 200, y: 65 }, { x: 220, y: 65 }, { x: 220, y: 80 }, { x: 200, y: 80 }];
  const holes = [inside, partial, outside];
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor([steppedRoof, neighbour], holes);
  fireEvent.click(screen.getByTitle("Zoom in"));
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: -80, top: -40 } as DOMRect);
  const top = { start: [240, 40], contacts: [[240, 60], [240, 100]] };
  const right = { start: [300, topFirst ? 125 : 70], contacts: [[292, topFirst ? 125 : 70], [284, topFirst ? 125 : 70]] };
  const snapshots: { outlines: Point[][]; holes: Point[][] }[] = [{ outlines: [steppedRoof, neighbour], holes }];
  for (const [index, drag] of (topFirst ? [top, right] : [right, top]).entries()) {
    event("pointerDown", drag.start[0], drag.start[1]);
    for (const [x, y] of drag.contacts) {
      event("pointerMove", x, y);
      expect(screen.getByRole("status")).not.toHaveTextContent("blocked");
      expect(outlinesChanged).toHaveBeenCalledTimes(index);
    }
    const end = drag.contacts[drag.contacts.length - 1];
    event("pointerUp", end[0], end[1]);
    expect(outlinesChanged).toHaveBeenCalledTimes(index + 1);
    const outlines = outlinesChanged.mock.lastCall![0] as Point[][];
    expect(outlines[outlines.length - 1]).toEqual(neighbour);
    snapshots.push({ outlines, holes: holesChanged.mock.lastCall?.[0] ?? holes });
  }
  expect(snapshots[1].outlines).toHaveLength(topFirst ? 3 : 2);
  expect(snapshots[2].outlines).toHaveLength(2);
  expect(snapshots[2].holes).toEqual([inside]);
  expect(rasterizeOutlinesWithHoles(snapshots[2].outlines, snapshots[2].holes, 400, 300))
    .toEqual(rasterizeOutlinesWithHoles([trimmedRoofWithNotch, neighbour], [inside], 400, 300));
  for (const snapshot of [snapshots[1], snapshots[0]]) {
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(outlinesChanged.mock.lastCall![0]).toEqual(snapshot.outlines);
    expect(holesChanged.mock.lastCall![0]).toEqual(snapshot.holes);
  }
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it.each([false, true])("cancels a trim preview without committing a split or removal, removing: %s", async removing => {
  const fragment = [{ x: 292, y: 100 }, { x: 300, y: 100 }, { x: 300, y: 150 }, { x: 292, y: 150 }];
  const { canvas, event, outlinesChanged, holesChanged } = await adjustmentEditor(removing ? [trimmedRoof, fragment] : [steppedRoof], []);
  event("pointerDown", removing ? 300 : 240, removing ? 125 : 40);
  event("pointerMove", removing ? 284 : 240, removing ? 125 : 100);
  expect(screen.getByRole("status")).not.toHaveTextContent("blocked");
  if (removing) fireEvent.pointerCancel(canvas, { pointerId: 7 });
  else fireEvent.keyDown(window, { key: "Escape" });
  event("pointerUp", removing ? 284 : 240, removing ? 125 : 100);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("rejects trimming away the last roof even after a valid preview, without saving or adding undo", async () => {
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor([roof], []);
  event("pointerDown", 120, 40);
  event("pointerMove", 120, 130);
  expect(screen.getByRole("status")).not.toHaveTextContent("blocked");
  event("pointerUp", 120, 280);
  expect(screen.getByRole("status")).toHaveTextContent("no insulation area");
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});
