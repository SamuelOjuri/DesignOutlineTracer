import { useState } from "react";
import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { syntheticAnnotation } from "@/test/roi";
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

type GuardProps = Pick<ComponentProps<typeof PaintBucketCanvas>, "outlineGeneration" | "unoutlinedRegions" | "regionLabels">;

async function editor(lines = vectors, holes: Point[][] = [hole], initialOutlines: Point[][] = [roof], guards: GuardProps = {}) {
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
  let updateGuards: (next: GuardProps) => void = () => {};
  function Editor() {
    const [outlines, setOutlines] = useState(initialOutlines);
    const [cutouts, setCutouts] = useState(holes);
    const [guardProps, setGuardProps] = useState(guards);
    externalEdit = setOutlines;
    updateGuards = setGuardProps;
    return <PaintBucketCanvas {...guardProps} pdfCanvas={source} roofOutlines={outlines} interiorHoles={cutouts} vectorSegments={lines}
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
  return { pointer, outlinesChanged, holesChanged, externalEdit, source, context,
    setGuards: (next: GuardProps) => act(() => updateGuards(next)) };
}

const accepted = () => screen.getByTestId("accepted-outline-overlay").querySelector("[data-accepted-outline]")!;
const finishButton = () => screen.getByRole("button", { name: "Finish redraw" });
const finish = () => fireEvent.click(finishButton());

it("redraws a missing rotated return using PDF endpoints and partial-edge anchors, with review and one Undo", async () => {
  const { pointer, outlinesChanged, holesChanged, source, context } = await editor();
  fireEvent.click(screen.getByTitle("Zoom in"));
  const p = pointer();
  p.click(start);
  expect(finishButton()).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Finish on outline" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Apply redraw" })).not.toBeInTheDocument();
  p.move({ x: inset.x + 0.4, y: inset.y - 0.6 });
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "endpoint");
  expect(screen.getAllByTestId("polyline-redraw-vector").length).toBeGreaterThan(0);
  p.click({ x: inset.x + 0.4, y: inset.y - 0.6 });
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(finishButton()).toBeDisabled();
  p.click(end);
  expect(screen.getByTestId("polyline-redraw-section")).toBeInTheDocument();
  expect(screen.getByTestId("polyline-redraw-preview")).toBeInTheDocument();
  expect(finishButton()).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  finish();
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

it("preserves a very narrow PDF return when continuing past a possible connection", async () => {
  const near = turn({ x: 238, y: 130 });
  const middle = turn({ x: 238, y: 200 });
  const nearEnd = turn({ x: 238, y: 240 });
  const { pointer, outlinesChanged } = await editor([{ start, end: near }, { start: near, end: middle }, { start: middle, end: nearEnd }]);
  const p = pointer();
  p.click(start);
  p.move(near);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "endpoint");
  p.click(near);
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(screen.queryByRole("button", { name: "Apply redraw" })).not.toBeInTheDocument();
  expect(finishButton()).toBeDisabled();
  p.click(middle);
  expect(finishButton()).toBeEnabled();
  p.click(nearEnd, true);
  const retainedMiddle = screen.getAllByTestId("polyline-redraw-point")[2];
  expect(Number(retainedMiddle.getAttribute("cx"))).toBeCloseTo(middle.x, 8);
  expect(Number(retainedMiddle.getAttribute("cy"))).toBeCloseTo(middle.y, 8);
  expect(finishButton()).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
  finish();
  const result = outlinesChanged.mock.lastCall![0][0] as Point[];
  expect(result.some(point => Math.hypot(point.x - near.x, point.y - near.y) < 1e-7)).toBe(true);
  expect(result.some(point => Math.hypot(point.x - nearEnd.x, point.y - nearEnd.y) < 1e-7)).toBe(true);
  expect(result.some(point => Math.hypot(point.x - roof[2].x, point.y - roof[2].y) < 1e-7)).toBe(false);
});

it("supports free placement and keeps drawing after a connection, with Back restoring the previous candidate", async () => {
  const { pointer, outlinesChanged } = await editor([]);
  expect(screen.getByRole("status")).toHaveTextContent("No PDF vector lines are available");
  const p = pointer();
  p.click(start);
  p.move(inset);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "free");
  p.click(inset);
  expect(finishButton()).toBeDisabled();
  p.click(end);
  expect(finishButton()).toBeEnabled();
  const preview = screen.getByTestId("polyline-redraw-preview").getAttribute("points");
  p.click(turn({ x: 180, y: 210 }));
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(4);
  expect(finishButton()).toBeDisabled();
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
  expect(finishButton()).toBeEnabled();
  expect(screen.getByTestId("polyline-redraw-preview")).toHaveAttribute("points", preview!);
  expect(outlinesChanged).not.toHaveBeenCalled();
  finish();
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
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
  p.click(end);
  fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  expect(finishButton()).toBeDisabled();
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(outlinesChanged).not.toHaveBeenCalled();
});

it("shows the alternate old boundary path and blocks a redraw that changes an existing cutout", async () => {
  const { pointer, outlinesChanged } = await editor();
  const p = pointer();
  p.click(start);
  p.click(inset);
  p.click(end);
  const initialPath = screen.getByTestId("polyline-redraw-section").getAttribute("points");
  fireEvent.click(screen.getByRole("button", { name: "Other path" }));
  expect(screen.getByTestId("polyline-redraw-section").getAttribute("points")).not.toBe(initialPath);
  fireEvent.click(screen.getByRole("button", { name: /^Clear$/ }));
  p.click(start);
  p.click(turn({ x: 70, y: 90 }), true);
  p.click(end);
  expect(finishButton()).toBeDisabled();
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

const endpointVectors: VectorSegment[] = [{ start, end: inset }, { start: inset, end: roof[2] }];

it("previews only a clicked reconnection and keeps that preview stable until Finish redraw, with one Undo", async () => {
  const { pointer, outlinesChanged, holesChanged } = await editor(endpointVectors);
  fireEvent.click(screen.getByTitle("Zoom in"));
  const p = pointer();
  p.click(start);
  p.click(inset);
  p.move({ x: roof[2].x + 0.35, y: roof[2].y - 0.45 });
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  expect(screen.getByText("Reconnect to outline")).toBeInTheDocument();
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  expect(finishButton()).toBeDisabled();
  p.click({ x: roof[2].x + 0.35, y: roof[2].y - 0.45 });
  expect(finishButton()).toBeEnabled();
  const preview = screen.getByTestId("polyline-redraw-preview").getAttribute("points");
  expect(preview).not.toBe(ringText(roof));
  expect(screen.getByTestId("polyline-redraw-section")).toBeInTheDocument();
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Apply redraw" })).not.toBeInTheDocument();
  p.move(roof[0]);
  expect(screen.getByTestId("polyline-redraw-preview")).toHaveAttribute("points", preview!);
  fireEvent.pointerLeave(p.surface);
  expect(screen.getByTestId("polyline-redraw-preview")).toHaveAttribute("points", preview!);
  expect(finishButton()).toBeEnabled();
  finish();
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(holesChanged).not.toHaveBeenCalled();
  expect(accepted()).toHaveAttribute("points", preview!);
  const result = outlinesChanged.mock.lastCall![0][0] as Point[];
  for (const point of [start, inset, roof[2]]) {
    expect(result.some(existing => Math.hypot(existing.x - point.x, existing.y - point.y) < 1e-7)).toBe(true);
  }
  expect(screen.queryAllByTestId("polyline-redraw-point")).toHaveLength(0);
  expect(screen.getByTestId("polyline-redraw-overlay")).toBeInTheDocument();
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged).toHaveBeenCalledTimes(2);
  expect(outlinesChanged.mock.lastCall![0]).toEqual([roof]);
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("lets the clicked reconnection preview switch which existing boundary path will be replaced", async () => {
  const { pointer, outlinesChanged } = await editor(endpointVectors);
  const p = pointer();
  p.click(start); p.click(inset); p.click(roof[2]);
  const section = screen.getByTestId("polyline-redraw-section").getAttribute("points");
  fireEvent.click(screen.getByRole("button", { name: "Other path" }));
  expect(screen.getByTestId("polyline-redraw-section").getAttribute("points")).not.toBe(section);
  expect(outlinesChanged).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Other path" }));
  expect(screen.getByTestId("polyline-redraw-section")).toHaveAttribute("points", section!);
  finish();
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
});

it("reconnects to a clicked outline vertex despite a nearby mismatched PDF endpoint", async () => {
  const nearby = turn({ x: 238, y: 240 });
  const { pointer, outlinesChanged } = await editor([{ start, end: inset }, { start: inset, end: nearby }]);
  const p = pointer();
  p.click(start); p.click(inset); p.move(roof[2]);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  p.click(roof[2]);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(3);
  expect(finishButton()).toBeEnabled();
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  finish();
  const result = outlinesChanged.mock.lastCall![0][0] as Point[];
  expect(result.some(point => Math.hypot(point.x - roof[2].x, point.y - roof[2].y) < 1e-7)).toBe(true);
  expect(result.some(point => Math.hypot(point.x - nearby.x, point.y - nearby.y) < 1e-7)).toBe(false);
});

it("recognises an exact PDF endpoint connection within the PDF snap radius beyond the outline hit radius", async () => {
  const { pointer, outlinesChanged } = await editor();
  const p = pointer();
  p.click(start); p.click(inset);
  const scale = parseFloat(screen.getByTestId("paint-interaction-canvas").style.width) / width;
  const raw = turn({ x: 210, y: 240 - 8 / scale });
  p.move(raw);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  expect(finishButton()).toBeDisabled();
  p.click(raw);
  expect(finishButton()).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
  const draftPoints = screen.getAllByTestId("polyline-redraw-point");
  const last = draftPoints[draftPoints.length - 1];
  expect(Number(last.getAttribute("cx"))).toBeCloseTo(end.x, 8);
  expect(Number(last.getAttribute("cy"))).toBeCloseTo(end.y, 8);
});

it("excludes the start and other roof outlines from direct endpoint completion", async () => {
  const other = [{ x: 430, y: 80 }, { x: 470, y: 80 }, { x: 470, y: 120 }, { x: 430, y: 120 }];
  const initial = [roof, other];
  const lines = [{ start: roof[1], end: inset }, { start: inset, end: other[0] }];
  const { pointer, outlinesChanged } = await editor(lines, [hole], initial);
  const p = pointer();
  p.click(roof[1]);
  p.move(roof[1]);
  expect(screen.getByTestId("polyline-redraw-cursor")).not.toHaveAttribute("data-snap", "finish");
  p.click(roof[1]);
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(1);
  p.click(inset); p.move(other[0]);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "endpoint");
  p.click(other[0]);
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(3);
  expect(finishButton()).toBeDisabled();
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByTestId("accepted-outline-overlay").querySelectorAll("[data-accepted-outline]")).toHaveLength(2);
});

it("Alt chooses a precise edge connection near a vertex and leaves the draft unapplied", async () => {
  const { pointer, outlinesChanged } = await editor(endpointVectors);
  const p = pointer();
  const precise = turn({ x: 238, y: 240 });
  p.click(start); p.click(inset); p.move(precise);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("cx", String(roof[2].x));
  p.move(precise, true);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  expect(Number(screen.getByTestId("polyline-redraw-cursor").getAttribute("cx"))).toBeCloseTo(precise.x, 8);
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
  p.click(precise, true);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(3);
  expect(finishButton()).toBeEnabled();
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  finish();
  const result = outlinesChanged.mock.lastCall![0][0] as Point[];
  expect(result.some(point => Math.hypot(point.x - precise.x, point.y - precise.y) < 1e-7)).toBe(true);
  expect(result.some(point => Math.hypot(point.x - roof[2].x, point.y - roof[2].y) < 1e-7)).toBe(false);
});

it("keeps an invalid protected-cutout completion as an unchanged draft with no Undo entry", async () => {
  const insideHole = turn({ x: 70, y: 90 });
  const lines = [{ start, end: insideHole }, { start: insideHole, end: roof[2] }];
  const { pointer, outlinesChanged, holesChanged } = await editor(lines);
  const p = pointer();
  p.click(start); p.click(insideHole); p.move(roof[2]);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  p.click(roof[2]);
  expect(screen.getByRole("status")).toHaveTextContent(/blocked|cutout|opening|cross/i);
  expect(p.surface.querySelector('[stroke="#dc2626"]')).not.toBeNull();
  const draft = screen.getByTestId("polyline-redraw-draft").getAttribute("points");
  expect(finishButton()).toBeDisabled();
  finish();
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(holesChanged).not.toHaveBeenCalled();
  expect(screen.getByTestId("polyline-redraw-draft")).toHaveAttribute("points", draft!);
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(screen.getByRole("status")).not.toHaveTextContent(/Redraw blocked/);
  expect(outlinesChanged).not.toHaveBeenCalled();
});

it("never applies an endpoint completion from dragging or a cancelled pointer", async () => {
  const { pointer, outlinesChanged } = await editor(endpointVectors);
  const p = pointer();
  p.click(start); p.click(inset); p.move(roof[2]);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  p.down(roof[2]); p.move({ x: roof[2].x + 20, y: roof[2].y + 20 }); p.up(roof[2]);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(finishButton()).toBeDisabled();
  p.move(roof[2]); p.down(roof[2]);
  fireEvent.pointerCancel(p.surface, { pointerId: 7 }); p.up(roof[2]);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  expect(finishButton()).toBeDisabled();
  expect(screen.queryByTestId("polyline-redraw-preview")).not.toBeInTheDocument();
});

it("keeps drafting but disables Finish redraw while outline generation is running or awaiting review", async () => {
  const { pointer, outlinesChanged, setGuards } = await editor(endpointVectors, [hole], [roof], { outlineGeneration: "running" });
  fireEvent.click(screen.getByTitle("Zoom in"));
  const p = pointer();
  p.click(start); p.click(inset);
  expect(screen.getAllByTestId("polyline-redraw-point")).toHaveLength(2);
  p.move(roof[2]);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  p.click(roof[2]);
  expect(screen.getByRole("status")).toHaveTextContent("Finish or cancel outline generation before applying this redraw.");
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(accepted()).toHaveAttribute("points", ringText(roof));
  expect(screen.getByTestId("polyline-redraw-preview")).toBeInTheDocument();
  expect(finishButton()).toBeDisabled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
  setGuards({ outlineGeneration: "review" });
  expect(screen.getByRole("status")).toHaveTextContent("Use or discard the generated outline proposal before applying this redraw.");
  expect(finishButton()).toBeDisabled();
  setGuards({ outlineGeneration: null });
  expect(screen.getByRole("status")).not.toHaveTextContent(/outline generation|outline proposal/);
  expect(finishButton()).toBeEnabled();
  finish();
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(accepted()).not.toHaveAttribute("points", ringText(roof));
});

const outerStart = turn({ x: 270, y: 130 }), outerEnd = turn({ x: 270, y: 240 });
const outwardVectors: VectorSegment[] = [{ start, end: outerStart }, { start: outerStart, end: outerEnd }, { start: outerEnd, end: roof[2] }];
// Source x 300..500, y 200..400: it already overlaps the roof's right side before any redraw.
const pendingArea = { unoutlinedRegions: [syntheticAnnotation("roi-east", { box_2d: [500, 600, 1000, 1000] })],
  regionLabels: { "roi-east": "Roof area 2" } };

it("warns before a redraw adds roof area inside a roof area that has not been outlined yet", async () => {
  const { pointer, outlinesChanged } = await editor(outwardVectors, [hole], [roof], pendingArea);
  fireEvent.click(screen.getByTitle("Zoom in"));
  const p = pointer();
  p.click(start); p.click(outerStart); p.click(outerEnd); p.move(roof[2]);
  expect(screen.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
  p.click(roof[2]);
  expect(screen.getByRole("status")).toHaveTextContent("This redraw extends into Roof area 2, which has not been outlined yet");
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("Roof area 2");
  // A warning, not a block: the user can still apply an intended extension.
  expect(finishButton()).toBeEnabled();
  finish();
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged.mock.lastCall![0][0]).toHaveLength(7);
});

it("finishes an inward redraw without warning when its roof only already overlapped a pending roof area", async () => {
  const { pointer, outlinesChanged } = await editor(endpointVectors, [hole], [roof], pendingArea);
  fireEvent.click(screen.getByTitle("Zoom in"));
  const p = pointer();
  p.click(start); p.click(inset); p.move(roof[2]);
  p.click(roof[2]);
  expect(screen.getByRole("status")).not.toHaveTextContent("Roof area 2");
  expect(finishButton()).toBeEnabled();
  expect(outlinesChanged).not.toHaveBeenCalled();
  finish();
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
});
