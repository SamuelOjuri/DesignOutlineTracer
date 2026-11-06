import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import type { Point } from "@/types/roof";
import type { VectorSegment } from "@/types/outline";
import { PaintBucketCanvas } from "./PaintBucketCanvas";

vi.mock("@/utils/floodFill", () => ({
  buildEdgeMap: () => new Uint8Array(80),
  buildRegionMap: () => ({ regionLabels: new Int32Array(80), regionSeeds: new Map() }),
}));

afterEach(() => vi.unstubAllGlobals());

const width = 500, height = 400;
const rotation = 20 * Math.PI / 180;
const turn = ({ x, y }: Point): Point => ({ x: 150 + x * Math.cos(rotation) - y * Math.sin(rotation),
  y: 20 + x * Math.sin(rotation) + y * Math.cos(rotation) });
const ring = (pairs: number[][]) => pairs.map(([x, y]) => turn({ x, y }));
const roof = ring([[40, 40], [240, 40], [240, 240], [40, 240]]);
const hole = ring([[70, 80], [90, 80], [90, 100], [70, 100]]);
const start = turn({ x: 240, y: 130 });
const inset = turn({ x: 210, y: 130 });
const end = turn({ x: 210, y: 240 });
const vectors: VectorSegment[] = [{ start, end: inset }, { start: inset, end }];
const ringText = (points: Point[]) => points.map(point => `${point.x},${point.y}`).join(" ");

async function editor(lines = vectors, holes: Point[][] = [hole]) {
  const context = Object.assign(mockCanvasContext(), {
    getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4), width, height }),
    putImageData: vi.fn(),
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  });
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  const source = document.createElement("canvas");
  source.width = width; source.height = height;
  const outlinesChanged = vi.fn(), holesChanged = vi.fn();
  let externalEdit: (outlines: Point[][]) => void = () => {};
  function Editor() {
    const [outlines, setOutlines] = useState([roof]);
    const [cutouts, setCutouts] = useState(holes);
    externalEdit = setOutlines;
    return <PaintBucketCanvas pdfCanvas={source} roofOutlines={outlines} interiorHoles={cutouts} vectorSegments={lines}
      onOutlinesExtracted={(next, index, remap) => { outlinesChanged(next, index, remap); setOutlines(next); }}
      onHolesExtracted={next => { holesChanged(next); setCutouts(next); }} />;
  }
  render(<Editor />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Adjust" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Adjust" }));
  fireEvent.click(screen.getByRole("button", { name: /^Redraw$/ }));
  const canvas = screen.getByTestId("paint-interaction-canvas");
  const pointer = (left = -90, top = -45) => {
    const surface = screen.getByTestId("polyline-redraw-overlay");
    vi.spyOn(surface, "getBoundingClientRect").mockImplementation(() => ({ left, top,
      width: parseFloat(canvas.style.width), height: parseFloat(canvas.style.height) } as DOMRect));
    const at = (point: Point, altKey = false) => {
      const scale = parseFloat(canvas.style.width) / width;
      return { pointerId: 7, button: 0, clientX: left + point.x * scale, clientY: top + point.y * scale, altKey };
    };
    return {
      surface,
      click: (point: Point, altKey = false) => { fireEvent.pointerDown(surface, at(point, altKey)); fireEvent.pointerUp(surface, at(point, altKey)); },
      down: (point: Point) => fireEvent.pointerDown(surface, at(point)),
      move: (point: Point, altKey = false) => fireEvent.pointerMove(surface, at(point, altKey)),
      up: (point: Point) => fireEvent.pointerUp(surface, at(point)),
    };
  };
  return { pointer, outlinesChanged, holesChanged, externalEdit, source, context };
}

const accepted = () => screen.getByTestId("accepted-outline-overlay").querySelector("[data-accepted-outline]")!;
const finish = () => fireEvent.click(screen.getByRole("button", { name: "Finish on outline" }));

it("redraws a missing rotated return using PDF endpoints and partial-edge anchors, with review and one Undo", async () => {
  const { pointer, outlinesChanged, holesChanged, source, context } = await editor();
  fireEvent.click(screen.getByTitle("Zoom in"));
  const p = pointer();
  p.click(start);
  p.move({ x: inset.x + 0.4, y: inset.y - 0.6 });
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "endpoint");
  expect(screen.getAllByTestId("polyline-redraw-vector").length).toBeGreaterThan(0);
  p.click({ x: inset.x + 0.4, y: inset.y - 0.6 });
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  finish();
  p.click(end);
  expect(screen.getByTestId("polyline-redraw-section")).toBeInTheDocument();
  expect(screen.getByTestId("polyline-redraw-preview")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Apply redraw" })).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  fireEvent.click(screen.getByRole("button", { name: "Apply redraw" }));
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  const result = outlinesChanged.mock.lastCall![0] as Point[][];
  expect(result[0]).toHaveLength(6);
  for (const point of [start, inset, end, roof[0], roof[1], roof[3]]) {
    expect(result[0].some(existing => Math.hypot(point.x - existing.x, point.y - existing.y) < 1e-7)).toBe(true);
  }
  expect(result[0].some(point => Math.hypot(point.x - roof[2].x, point.y - roof[2].y) < 1e-7)).toBe(false);
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  expect(screen.getByTestId("polyline-redraw-overlay")).toBeInTheDocument();
  expect(source.width).toBe(width);
  expect(context.putImageData).toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  expect(outlinesChanged.mock.lastCall![0]).toEqual([roof]);
  expect(holesChanged).toHaveBeenLastCalledWith([hole]);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("keeps snapping very narrow return points beside the old boundary until Finish is explicitly chosen", async () => {
  const near = turn({ x: 238, y: 130 });
  const nearEnd = turn({ x: 238, y: 240 });
  const { pointer, outlinesChanged } = await editor([{ start, end: near }, { start: near, end: nearEnd }]);
  const p = pointer();
  p.click(start);
  p.move(near);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "endpoint");
  p.click(near);
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Apply redraw" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Finish on outline" })).toBeInTheDocument();
  finish();
  p.click(nearEnd, true);
  expect(screen.getByRole("button", { name: "Apply redraw" })).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Apply redraw" }));
  const result = outlinesChanged.mock.lastCall![0][0] as Point[];
  expect(result.some(point => Math.hypot(point.x - nearEnd.x, point.y - nearEnd.y) < 1e-7)).toBe(true);
  expect(result.some(point => Math.hypot(point.x - roof[2].x, point.y - roof[2].y) < 1e-7)).toBe(false);
});

it("supports free placement without PDF vectors and switches between tracing and finishing", async () => {
  const { pointer, outlinesChanged } = await editor([]);
  expect(screen.getByRole("status")).toHaveTextContent("No PDF vector lines are available");
  const p = pointer();
  p.click(start);
  p.move(inset);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "free");
  p.click(inset);
  finish();
  fireEvent.click(screen.getByRole("button", { name: "Keep drawing" }));
  expect(screen.getByRole("button", { name: "Finish on outline" })).toBeInTheDocument();
  finish();
  p.click(end);
  expect(screen.getByRole("button", { name: "Apply redraw" })).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
});

it("Alt places a free point near a PDF endpoint and Back removes the point before editing the finish", async () => {
  const { pointer, outlinesChanged } = await editor();
  const p = pointer();
  const free = { x: inset.x + 2, y: inset.y + 2 };
  p.click(start);
  p.move(free, true);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "free");
  p.click(free, true);
  const draft = screen.getByTestId("polyline-redraw-draft").getAttribute("points")!.split(" ")
    .map(pair => pair.split(",").map(Number));
  expect(draft).toHaveLength(2);
  [start, free].forEach((point, index) => {
    expect(draft[index][0]).toBeCloseTo(point.x, 8);
    expect(draft[index][1]).toBeCloseTo(point.y, 8);
  });
  fireEvent.keyDown(window, { key: "Backspace" });
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(1);
  p.click(inset);
  finish();
  p.click(end);
  fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Finish on outline" })).toBeInTheDocument();
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(outlinesChanged).not.toHaveBeenCalled();
});

it("shows the alternate old boundary path and blocks a redraw that changes an existing cutout", async () => {
  const { pointer, outlinesChanged } = await editor();
  const p = pointer();
  p.click(start);
  p.click(inset);
  finish(); p.click(end);
  const initialPath = screen.getByTestId("polyline-redraw-section").getAttribute("points");
  fireEvent.click(screen.getByRole("button", { name: "Other path" }));
  expect(screen.getByTestId("polyline-redraw-section").getAttribute("points")).not.toBe(initialPath);
  fireEvent.click(screen.getByRole("button", { name: /^Clear$/ }));
  p.click(start);
  p.click(turn({ x: 70, y: 90 }), true);
  finish(); p.click(end);
  expect(screen.getByRole("button", { name: "Apply redraw" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(/blocked|cutout|opening|cross/i);
  expect(outlinesChanged).not.toHaveBeenCalled();
});

it("discards drafts on Escape, switching tools, external geometry changes, and pointer cancellation", async () => {
  const { pointer, outlinesChanged, externalEdit } = await editor();
  let p = pointer();
  p.click(start); p.click(inset);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByTestId("polyline-redraw-overlay")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Redraw$/ }));
  p = pointer(); p.click(start); p.click(inset);
  fireEvent.click(screen.getByRole("button", { name: /^Snap to line$/ }));
  expect(screen.queryByTestId("polyline-redraw-overlay")).not.toBeInTheDocument();
  expect(screen.getByTestId("side-fit-overlay")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Redraw$/ }));
  expect(screen.queryByTestId("side-fit-overlay")).not.toBeInTheDocument();
  p = pointer(); p.click(start); p.click(inset);
  act(() => externalEdit([roof.map((point, index) => index === 0 ? { ...point, x: point.x + 1 } : point)]));
  expect(screen.queryAllByTestId("polyline-redraw-point")).toHaveLength(0);
  expect(screen.getByTestId("polyline-redraw-overlay")).toBeInTheDocument();
  p.down(start); fireEvent.pointerCancel(p.surface, { pointerId: 7 }); p.up(start);
  expect(screen.queryAllByTestId("polyline-redraw-point")).toHaveLength(0);
  p.click(start); p.down(inset); p.move(end); p.up(end);
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(1);
  expect(screen.getByRole("status")).toHaveTextContent("Dragging does not change");
  expect(outlinesChanged).not.toHaveBeenCalled();
});
