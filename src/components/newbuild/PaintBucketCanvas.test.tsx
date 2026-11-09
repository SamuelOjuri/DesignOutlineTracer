import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { steppedRoof, trimmedRoof, trimmedRoofWithNotch } from "@/test/roofBoundary";
import { rasterizeOutlinesWithHoles } from "@/utils/polygonAdjust";
import { syntheticAnnotation } from "@/test/roi";
import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
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

async function adjustmentEditor(outlines = [roof, otherRoof], holes = [cutout], vectorSegments: VectorSegment[] = []) {
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
    return <PaintBucketCanvas pdfCanvas={source} roofOutlines={currentOutlines} interiorHoles={currentHoles} vectorSegments={vectorSegments}
      onOutlinesExtracted={(next, index) => { outlinesChanged(next, index); setOutlines(next); }}
      onHolesExtracted={next => { holesChanged(next); setHoles(next); }} />;
  }
  render(<Editor />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Adjust" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
  const canvas = screen.getByTestId("paint-interaction-canvas") as HTMLCanvasElement;
  const event = (type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number,
    modifiers: boolean | Pick<PointerEventInit, "shiftKey" | "altKey"> = false) => {
    const bounds = screen.getByTestId("paint-source-canvas").getBoundingClientRect();
    const scale = parseFloat(canvas.style.width) / width;
    fireEvent[type](canvas, { pointerId: 7, button: 0, clientX: bounds.left + x * scale, clientY: bounds.top + y * scale,
      ...(typeof modifiers === "boolean" ? { shiftKey: modifiers } : modifiers) });
  };
  return { canvas, event, context, outlinesChanged, holesChanged };
}

it("previews a fitted side at zoom, cycles parallel targets and applies with a single undo", async () => {
  const vectors = [195, 198].map(x => ({ start: { x, y: 40 }, end: { x, y: 260 } }));
  const { canvas, outlinesChanged, holesChanged } = await adjustmentEditor([roof, otherRoof], [cutout], vectors);
  fireEvent.click(screen.getByTitle("Zoom in"));
  fireEvent.click(screen.getByRole("button", { name: "Snap to line" }));
  const overlay = screen.getByTestId("side-fit-overlay");
  vi.spyOn(overlay, "getBoundingClientRect").mockImplementation(() => ({ left: -80, top: -40,
    width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) } as DOMRect));
  const click = (x: number, y: number) => {
    const scale = parseFloat(canvas.style.width) / 400;
    const at = { button: 0, clientX: -80 + x * scale, clientY: -40 + y * scale };
    fireEvent.pointerDown(overlay, at);
    fireEvent.pointerUp(overlay, at);
  };
  click(201, 100);
  expect(screen.getByTestId("side-fit-section")).toHaveAttribute("points", "200,40 202,160 200,260");
  click(196, 150);
  expect(screen.getByTestId("side-fit-target")).toHaveAttribute("data-source", "vector");
  expect(screen.getByTestId("side-fit-preview")).toHaveAttribute("points", "40,40 195,40 195,260 40,260");
  expect(outlinesChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Next line (1/2)" }));
  expect(screen.getByTestId("side-fit-preview")).toHaveAttribute("points", "40,40 198,40 198,260 40,260");
  fireEvent.click(screen.getByRole("button", { name: "Apply fit" }));
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged).toHaveBeenLastCalledWith([[{ x: 40, y: 40 }, { x: 198, y: 40 }, { x: 198, y: 260 }, { x: 40, y: 260 }], otherRoof], 0);
  expect(holesChanged).not.toHaveBeenCalled();
  // The tool stays on for the next side; only the finished selection is cleared.
  expect(screen.getByTestId("side-fit-overlay")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Snap to line" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByTestId("side-fit-section")).not.toBeInTheDocument();
  expect(screen.queryByTestId("side-fit-preview")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged).toHaveBeenLastCalledWith([roof, otherRoof], undefined);
  expect(holesChanged).toHaveBeenLastCalledWith([cutout]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

/** Pointer helpers for the Snap to line surface, in source-canvas coordinates. */
function fitPointer(canvas: HTMLCanvasElement) {
  const surface = screen.getByTestId("side-fit-overlay");
  vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => ({ left: 0, top: 0,
    width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) } as DOMRect));
  const at = (x: number, y: number) => {
    const scale = parseFloat(canvas.style.width) / 400;
    return { button: 0, clientX: x * scale, clientY: y * scale };
  };
  return {
    surface,
    down: (x: number, y: number) => fireEvent.pointerDown(surface, at(x, y)),
    move: (x: number, y: number) => fireEvent.pointerMove(surface, at(x, y)),
    up: (x: number, y: number) => fireEvent.pointerUp(surface, at(x, y)),
  };
}

it("drags a side onto a drawing line, applies the previewed fit on release and stays on for the next side", async () => {
  const vectors = [195, 198].map(x => ({ start: { x, y: 40 }, end: { x, y: 260 } }));
  const { canvas, outlinesChanged, holesChanged } = await adjustmentEditor([roof, otherRoof], [cutout], vectors);
  fireEvent.click(screen.getByTitle("Zoom in"));
  fireEvent.click(screen.getByRole("button", { name: "Snap to line" }));
  const pointer = fitPointer(canvas);
  pointer.move(201, 100);
  expect(screen.getByTestId("side-fit-grab")).toHaveAttribute("points", "200,40 202,160 200,260");
  pointer.down(201, 100);
  expect(screen.getByTestId("side-fit-section")).toHaveAttribute("points", "200,40 202,160 200,260");
  expect(screen.queryByTestId("side-fit-target")).not.toBeInTheDocument();
  pointer.move(195.5, 150);
  expect(await screen.findByTestId("side-fit-target")).toHaveAttribute("x1", "195");
  expect(screen.getByTestId("side-fit-candidate")).toHaveAttribute("x1", "198");
  expect(screen.getByTestId("side-fit-preview")).toHaveAttribute("points", "40,40 195,40 195,260 40,260");
  expect(screen.getByRole("status")).toHaveTextContent("Release to snap to the highlighted line.");
  expect(outlinesChanged).not.toHaveBeenCalled();
  pointer.up(195.5, 150);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged).toHaveBeenLastCalledWith([[{ x: 40, y: 40 }, { x: 195, y: 40 }, { x: 195, y: 260 }, { x: 40, y: 260 }], otherRoof], 0);
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Snap to line" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByTestId("side-fit-overlay")).toBe(pointer.surface);
  expect(screen.queryByTestId("side-fit-section")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply fit" })).not.toBeInTheDocument();
  // The fitted side can be grabbed again straight away and moved to the outer face.
  pointer.down(195, 120);
  pointer.move(198.5, 120);
  pointer.up(198.5, 120);
  expect(outlinesChanged).toHaveBeenCalledTimes(2);
  expect(outlinesChanged).toHaveBeenLastCalledWith([[{ x: 40, y: 40 }, { x: 198, y: 40 }, { x: 198, y: 260 }, { x: 40, y: 260 }], otherRoof], 0);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged).toHaveBeenLastCalledWith([[{ x: 40, y: 40 }, { x: 195, y: 40 }, { x: 195, y: 260 }, { x: 40, y: 260 }], otherRoof], undefined);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged).toHaveBeenLastCalledWith([roof, otherRoof], undefined);
  expect(holesChanged).toHaveBeenLastCalledWith([cutout]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("changes nothing when a drag is released away from a line, on a blocked fit, or cancelled", async () => {
  const vectors = [{ start: { x: 195, y: 40 }, end: { x: 195, y: 260 } }, { start: { x: 285, y: 40 }, end: { x: 285, y: 260 } }];
  const { canvas, outlinesChanged } = await adjustmentEditor([roof, otherRoof], [cutout], vectors);
  fireEvent.click(screen.getByTitle("Zoom in"));
  fireEvent.click(screen.getByRole("button", { name: "Snap to line" }));
  const pointer = fitPointer(canvas);
  pointer.down(201, 100);
  pointer.move(240, 150);
  expect(screen.queryByTestId("side-fit-target")).not.toBeInTheDocument();
  pointer.up(240, 150);
  expect(screen.getByRole("status")).toHaveTextContent("Released away from a drawing line. Nothing changed.");
  expect(screen.queryByTestId("side-fit-section")).not.toBeInTheDocument();
  // A blocked line previews in red and is not applied. Previews arrive on the trailing aim update.
  pointer.down(201, 100);
  pointer.move(285, 150);
  expect(await screen.findByTestId("side-fit-target")).toHaveAttribute("stroke", "#dc2626");
  expect(screen.queryByTestId("side-fit-preview")).not.toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(/Fit blocked: /);
  pointer.up(285, 150);
  expect(screen.getByRole("status")).toHaveTextContent(/Fit blocked: .* Nothing changed\.$/);
  pointer.down(201, 100);
  pointer.move(195.5, 150);
  expect(await screen.findByTestId("side-fit-preview")).toBeInTheDocument();
  fireEvent.pointerCancel(pointer.surface);
  pointer.up(195.5, 150);
  expect(screen.queryByTestId("side-fit-preview")).not.toBeInTheDocument();
  pointer.down(201, 100);
  pointer.move(195.5, 150);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("side-fit-overlay")).not.toBeInTheDocument();
  pointer.up(195.5, 150);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("keeps a press without movement as a side selection for the click-to-review flow", async () => {
  const vectors = [{ start: { x: 195, y: 40 }, end: { x: 195, y: 260 } }];
  const { canvas, outlinesChanged } = await adjustmentEditor([roof, otherRoof], [cutout], vectors);
  fireEvent.click(screen.getByTitle("Zoom in"));
  fireEvent.click(screen.getByRole("button", { name: "Snap to line" }));
  const pointer = fitPointer(canvas);
  pointer.down(201, 100);
  pointer.up(201, 100);
  expect(screen.getByTestId("side-fit-section")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply fit" })).toBeDisabled();
  pointer.down(195.5, 150);
  pointer.up(195.5, 150);
  expect(screen.getByTestId("side-fit-preview")).toHaveAttribute("points", "40,40 195,40 195,260 40,260");
  expect(screen.getByRole("button", { name: "Apply fit" })).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
});

it("cancels fitting without mutation on Escape, tool change and existing geometry changes", async () => {
  const { outlinesChanged } = await adjustmentEditor();
  fireEvent.click(screen.getByRole("button", { name: "Snap to line" }));
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("side-fit-overlay")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Snap to line" }));
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  expect(screen.queryByTestId("side-fit-overlay")).not.toBeInTheDocument();
  expect(outlinesChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
  fireEvent.click(screen.getByRole("button", { name: "Snap to line" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset" }));
  expect(screen.queryByTestId("side-fit-overlay")).not.toBeInTheDocument();
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged).toHaveBeenLastCalledWith([], undefined);
});

it("groups both subtools under Adjust and discards previews when switching between them", async () => {
  const { canvas, event, outlinesChanged } = await adjustmentEditor([roof, otherRoof], [cutout],
    [{ start: { x: 195, y: 40 }, end: { x: 195, y: 260 } }]);
  const adjust = screen.getByRole("button", { name: "Adjust" });
  const fit = screen.getByRole("button", { name: "Snap to line" });
  const straighten = screen.getByRole("button", { name: "Straighten" });
  const tools = screen.getByRole("group", { name: "Adjust tools" });
  expect(tools).toContainElement(fit);
  expect(tools).toContainElement(straighten);
  fireEvent.click(fit);
  const surface = screen.getByTestId("side-fit-overlay");
  vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => ({ left: 0, top: 0,
    width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) } as DOMRect));
  const scale = parseFloat(canvas.style.width) / 400;
  for (const [x, y] of [[201, 100], [195, 150]]) {
    fireEvent.pointerDown(surface, { button: 0, clientX: x * scale, clientY: y * scale });
    fireEvent.pointerUp(surface, { button: 0, clientX: x * scale, clientY: y * scale });
  }
  expect(screen.getByRole("button", { name: "Apply fit" })).toBeEnabled();
  fireEvent.click(straighten);
  expect(screen.queryByTestId("side-fit-preview")).not.toBeInTheDocument();
  expect(screen.queryByTestId("side-fit-overlay")).not.toBeInTheDocument();
  expect(straighten).toHaveAttribute("aria-pressed", "true");
  expect(adjust).toHaveAttribute("aria-pressed", "true");
  expect(fit).toHaveAttribute("aria-pressed", "false");
  event("pointerDown", 201, 100);
  event("pointerMove", 200, 100);
  fireEvent.click(fit);
  event("pointerUp", 200, 100);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(fit).toHaveAttribute("aria-pressed", "true");
  expect(straighten).toHaveAttribute("aria-pressed", "false");
  expect(adjust).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("button", { name: "Apply fit" })).not.toBeInTheDocument();
  fireEvent.click(fit);
  expect(screen.queryByTestId("side-fit-overlay")).not.toBeInTheDocument();
  expect(screen.getByTestId("accepted-outline-overlay").querySelectorAll("[data-outline-vertex]")).toHaveLength(roof.length + otherRoof.length);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  for (const name of ["Select", "Cut Out"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.queryByRole("button", { name: "Straighten" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snap to line" })).not.toBeInTheDocument();
  }
  fireEvent.click(adjust);
  expect(screen.getByRole("button", { name: "Straighten" })).toHaveAttribute("aria-pressed", "false");
  expect(screen.getByRole("button", { name: "Snap to line" })).toHaveAttribute("aria-pressed", "false");
});

it.each(["toggle", "Escape"])("returns from Straighten to normal dragging with %s", async exit => {
  const { event, outlinesChanged } = await adjustmentEditor();
  const straighten = screen.getByRole("button", { name: "Straighten" });
  fireEvent.click(straighten);
  expect(screen.getByRole("button", { name: "Adjust" })).toHaveAttribute("aria-pressed", "true");
  event("pointerDown", 201, 100);
  event("pointerMove", 200, 100);
  if (exit === "toggle") fireEvent.click(straighten);
  else fireEvent.keyDown(window, { key: "Escape" });
  event("pointerUp", 200, 100);
  expect(straighten).toHaveAttribute("aria-pressed", "false");
  expect(outlinesChanged).not.toHaveBeenCalled();
  event("pointerDown", 202, 160);
  event("pointerUp", 198, 150);
  expect(outlinesChanged).toHaveBeenLastCalledWith([roof.map((p, index) => index === 2 ? { x: 198, y: 150 } : p), otherRoof], 0);
});

it("highlights a merge at zoom, commits only on release and restores points and cutouts with one undo", async () => {
  const { canvas, event, outlinesChanged, holesChanged } = await adjustmentEditor();
  fireEvent.click(screen.getByTitle("Zoom in"));
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: -80, top: -40 } as DOMRect);
  event("pointerDown", 202, 160);
  event("pointerMove", 203, 42);
  expect(screen.getByRole("status")).toHaveTextContent("Merge vertex");
  const target = screen.getByTestId("outline-merge-target");
  expect(target).toHaveAttribute("cx", "200");
  expect(target).toHaveAttribute("cy", "40");
  expect(Number(target.getAttribute("r")) * parseFloat(canvas.style.width) / 400).toBeCloseTo(8);
  expect(outlinesChanged).not.toHaveBeenCalled();
  fireEvent.mouseLeave(canvas);
  expect(outlinesChanged).not.toHaveBeenCalled();
  event("pointerUp", 203, 42);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged).toHaveBeenLastCalledWith([roof.filter((_, index) => index !== 2), otherRoof], 0);
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.queryByTestId("outline-merge-target")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged.mock.lastCall![0]).toEqual([roof, otherRoof]);
  expect(holesChanged).toHaveBeenLastCalledWith([cutout]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it.each(["endpoint", "intersection"] as const)("snaps an Adjust vertex to an exact PDF %s at zoom while preserving its grab offset", async kind => {
  const target = { x: 218.25, y: 147.75 };
  const vectors: VectorSegment[] = kind === "endpoint"
    ? [{ start: target, end: { x: 188.25, y: 147.75 } }]
    : [{ start: { x: 188.25, y: 147.75 }, end: { x: 248.25, y: 147.75 } },
      { start: { x: 218.25, y: 117.75 }, end: { x: 218.25, y: 177.75 } }];
  const { canvas, event, outlinesChanged, holesChanged } = await adjustmentEditor([roof, otherRoof], [cutout], vectors);
  fireEvent.click(screen.getByTitle("Zoom in"));
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({ left: -80, top: -40 } as DOMRect);
  const scale = parseFloat(canvas.style.width) / 400;
  // Grab three source pixels to the right of the vertex, rather than at its centre.
  event("pointerDown", 205, 160);
  if (kind === "endpoint") {
    event("pointerMove", 227, 148);
    expect(Math.hypot(224 - target.x, 148 - target.y) * scale).toBeGreaterThan(10);
    expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  }
  event("pointerMove", 224, 149);
  expect(Math.hypot(224 - target.x, 149 - target.y) * scale).toBeGreaterThan(10);
  const marker = screen.getByTestId("adjust-pdf-snap");
  expect(marker).toHaveAttribute("data-snap", kind);
  expect(screen.getByRole("status")).toHaveTextContent(`PDF ${kind}`);
  const expected = roof.map((point, index) => index === 2 ? target : point);
  expect(screen.getByTestId("accepted-outline-overlay").querySelector('[data-accepted-outline="0"]'))
    .toHaveAttribute("points", expected.map(point => `${point.x},${point.y}`).join(" "));
  expect(outlinesChanged).not.toHaveBeenCalled();
  event("pointerUp", 224, 149);
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged).toHaveBeenLastCalledWith([expected, otherRoof], 0);
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged).toHaveBeenLastCalledWith([roof, otherRoof], undefined);
  expect(holesChanged).toHaveBeenLastCalledWith([cutout]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("keeps adjacent outline merges ahead of PDF snapping and lets Alt move freely past both targets", async () => {
  const vectors: VectorSegment[] = [{ start: { x: 201.5, y: 42.5 }, end: { x: 230, y: 42.5 } }];
  const { event, outlinesChanged } = await adjustmentEditor([roof, otherRoof], [cutout], vectors);
  event("pointerDown", 202, 160);
  event("pointerMove", 201, 42);
  expect(screen.getByRole("status")).toHaveTextContent("Merge vertex");
  expect(screen.getByTestId("outline-merge-target")).toBeInTheDocument();
  expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  event("pointerUp", 201, 42);
  expect(outlinesChanged).toHaveBeenLastCalledWith([roof.filter((_, index) => index !== 2), otherRoof], 0);
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  event("pointerDown", 202, 160);
  event("pointerMove", 201, 42, { altKey: true });
  expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  expect(screen.queryByTestId("outline-merge-target")).not.toBeInTheDocument();
  event("pointerUp", 201, 42, { altKey: true });
  expect(outlinesChanged).toHaveBeenLastCalledWith([
    roof.map((point, index) => index === 2 ? { x: 201, y: 42 } : point), otherRoof,
  ], 0);
});

it("leaves clicks and Adjust movement under two display pixels unchanged beside a PDF target", async () => {
  const vectors: VectorSegment[] = [{ start: { x: 205.25, y: 160.25 }, end: { x: 230, y: 160.25 } }];
  const { canvas, event, outlinesChanged } = await adjustmentEditor([roof], [cutout], vectors);
  fireEvent.click(screen.getByTitle("Zoom out"));
  expect(parseFloat(canvas.style.width) / 400).toBeLessThan(2);
  event("pointerDown", 202, 160);
  event("pointerMove", 203, 160);
  expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  expect(screen.getByTestId("accepted-outline-overlay").querySelector('[data-accepted-outline="0"]'))
    .toHaveAttribute("points", roof.map(point => `${point.x},${point.y}`).join(" "));
  event("pointerUp", 203, 160);
  event("pointerDown", 202, 160);
  event("pointerUp", 202, 160);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("rejects a PDF snap that would overlap another roof without displaying a valid snap or committing", async () => {
  const vectors: VectorSegment[] = [{ start: { x: 280.25, y: 100.25 }, end: { x: 310, y: 100.25 } }];
  const { event, outlinesChanged } = await adjustmentEditor([roof, otherRoof], [cutout], vectors);
  event("pointerDown", 202, 160);
  event("pointerMove", 277, 100);
  expect(screen.getByRole("status")).toHaveTextContent("Edit blocked:");
  expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  event("pointerUp", 277, 100);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("keeps accepted geometry aligned at zoom, shows handles only for Adjust and excludes both kinds of openings", async () => {
  const source = document.createElement("canvas");
  source.width = 400; source.height = 300;
  const onOutlinesExtracted = vi.fn();
  const penetration = [{ x: 130, y: 80 }, { x: 160, y: 80 }, { x: 160, y: 100 }, { x: 130, y: 100 }];
  const regions = [syntheticAnnotation()];
  const { rerender } = render(<PaintBucketCanvas pdfCanvas={source} roofOutlines={[roof]} interiorHoles={[cutout]}
    penetrationHoles={[penetration]} acceptedRegions={regions} onOutlinesExtracted={onOutlinesExtracted} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Adjust" })).toBeEnabled());
  const overlay = screen.getByTestId("accepted-outline-overlay");
  const boundary = overlay.querySelector('[data-accepted-outline="0"]');
  const coordinates = roof.map(point => `${point.x},${point.y}`).join(" ");
  expect(boundary).toHaveAttribute("points", coordinates);
  expect(overlay.querySelectorAll("[data-outline-opening]")).toHaveLength(2);
  expect(overlay.querySelectorAll("circle")).toHaveLength(0);
  expect(screen.getByTestId("annotation-box-roi-1")).toHaveAttribute("data-contextual", "true");
  fireEvent.click(screen.getByTitle("Zoom in"));
  expect(boundary).toHaveAttribute("points", coordinates);
  expect(boundary).toHaveAttribute("vector-effect", "non-scaling-stroke");
  expect(overlay.parentElement?.style.width).toBe(screen.getByTestId("paint-source-canvas").style.width);
  fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
  expect(overlay.querySelectorAll("[data-outline-vertex]")).toHaveLength(roof.length);
  const handle = overlay.querySelector("circle")!;
  const scale = parseFloat(screen.getByTestId("paint-source-canvas").style.width) / 400;
  expect(Number(handle.getAttribute("r")) * scale).toBeCloseTo(3);
  fireEvent.click(screen.getByRole("button", { name: "Straighten" }));
  expect(overlay.querySelectorAll("circle")).toHaveLength(0);
  expect(onOutlinesExtracted).not.toHaveBeenCalled();
  rerender(<PaintBucketCanvas pdfCanvas={source} roofOutlines={[]} acceptedRegions={regions}
    onOutlinesExtracted={onOutlinesExtracted} />);
  expect(screen.queryByTestId("accepted-outline-overlay")).not.toBeInTheDocument();
  expect(screen.getByTestId("annotation-box-roi-1")).toHaveAttribute("data-contextual", "false");
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
  const vectors: VectorSegment[] = [{ start: { x: 201.25, y: 40.25 }, end: { x: 230, y: 40.25 } },
    { start: { x: 221, y: 140 }, end: { x: 221, y: 180 } }];
  const { event, outlinesChanged, holesChanged } = await adjustmentEditor([skewed], [cutout], vectors);
  event("pointerDown", 202, 42);
  event("pointerMove", 201, 40, true);
  expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  event("pointerUp", 201, 40, true);
  expect(outlinesChanged).toHaveBeenLastCalledWith([rectangle], 0);
  event("pointerDown", 200, 160);
  event("pointerMove", 220, 160);
  expect(screen.queryByTestId("adjust-pdf-snap")).not.toBeInTheDocument();
  event("pointerUp", 220, 160);
  expect(outlinesChanged.mock.lastCall![0][0].filter((point: Point) => point.x === 220)).toHaveLength(2);
  expect(holesChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged).toHaveBeenLastCalledWith([rectangle], undefined);
  expect(holesChanged).toHaveBeenLastCalledWith([cutout]);
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
  const before = screen.getByTestId("accepted-outline-overlay").querySelector('[data-accepted-outline="0"]')!.getAttribute("points");
  event("pointerMove", 120, 130);
  expect(screen.getByTestId("accepted-outline-overlay").querySelector('[data-accepted-outline="0"]')).not.toHaveAttribute("points", before);
  expect(screen.getByTestId("accepted-outline-overlay").querySelectorAll("[data-outline-opening]")).toHaveLength(0);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByTestId("accepted-outline-overlay").querySelector('[data-accepted-outline="0"]')).toHaveAttribute("points", before);
  expect(screen.getByTestId("accepted-outline-overlay").querySelectorAll("[data-outline-opening]")).toHaveLength(1);
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
