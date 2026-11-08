import { useReducer, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { penetrationSession } from "@/test/penetrations";
import { syntheticAnnotation } from "@/test/roi";
import { footprintBox, penetrationArea } from "@/utils/penetrationGeometry";
import { roiSessionReducer } from "@/utils/roiSession";
import type { Point } from "@/types/roof";
import { RoiReviewCanvas } from "./RoiReviewCanvas";
import { RoiReviewSidebar } from "./RoiReviewSidebar";

const original: Point[] = [{ x: 280, y: 150 }, { x: 360, y: 150 }, { x: 360, y: 240 },
  { x: 320, y: 210 }, { x: 280, y: 240 }];

function Editor({ canvas, clipped = false, legacy = false, nearEdge = false }: {
  canvas: HTMLCanvasElement; clipped?: boolean; legacy?: boolean; nearEdge?: boolean;
}) {
  const [state, dispatch] = useReducer(roiSessionReducer, undefined, () => {
    const initial = penetrationSession();
    initial.pages["page-1"].source = { ...initial.pages["page-1"].source,
      vector_segments: [{ start: { x: 300, y: 160 }, end: { x: 300, y: 190 } }] };
    if (legacy) return initial;
    return roiSessionReducer(initial, { type: "review", page_id: "page-1", id: "rooflight", patch: {
      footprint: nearEdge ? [{ x: 20, y: 1 }, { x: 100, y: 1 }, { x: 100, y: 20 }, { x: 20, y: 20 }]
        : clipped ? [{ x: 720, y: 200 }, { x: 780, y: 200 }, { x: 780, y: 260 }, { x: 720, y: 260 }] : original,
    } });
  });
  const [selected, select] = useState("rooflight");
  const [adding, setAdding] = useState(false);
  const page = state.pages["page-1"];
  const annotations = page.annotations.filter(annotation => annotation.kind === "penetration");
  return <>
    <RoiReviewSidebar kind="penetration" page={page} selectedId={selected} adding={adding}
      onSelect={select} onAddingChange={setAdding} dispatch={dispatch}
      detection={{ busy: false, restarting: false, cancel: vi.fn(), detect: vi.fn(), feedback: undefined }} />
    <RoiReviewCanvas kind="penetration" page={page} pdfCanvas={canvas} annotations={annotations}
      selectedId={selected} adding={adding} onSelect={select} onAddingChange={setAdding}
      onUndoReview={() => dispatch({ type: "undo", page_id: "page-1" })}
      onEdit={(id, box_2d) => dispatch({ type: "review", page_id: "page-1", id, patch: { box_2d } })}
      onEditFootprint={(id, footprint) => dispatch({ type: "review", page_id: "page-1", id, patch: { footprint } })}
      onAdd={() => { throw new Error("Polygon workflow must retain the footprint."); }}
      onAddFootprint={footprint => {
        dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation("manual", {
          kind: "penetration", subtype: "riser", roi_id: "parent", review_status: "suggested", footprint,
          box_2d: footprintBox(footprint, { width: 800, height: 600 }),
        }) }); select("manual"); setAdding(false);
      }} />
    <button onClick={() => dispatch({ type: "review", page_id: "page-1", id: selected, patch: { label: "External review" } })}>
      External review</button>
    <output data-testid="workflow-footprint">{JSON.stringify(annotations.find(annotation => annotation.id === selected)?.footprint)}</output>
    <output data-testid="workflow-history">{page.history.length}</output>
  </>;
}

function setup(clipped = false, legacy = false, nearEdge = false) {
  const canvas = document.createElement("canvas"); canvas.width = 800; canvas.height = 600;
  render(<Editor canvas={canvas} clipped={clipped} legacy={legacy} nearEdge={nearEdge} />);
  const frame = screen.getByTestId("roi-source-canvas").parentElement!;
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => ({
    x: -120, y: -60, left: -120, top: -60, right: 680, bottom: 540,
    width: parseFloat(frame.style.width), height: parseFloat(frame.style.height), toJSON: () => ({}),
  }));
  const pointer = (x: number, y: number, altKey = true) => ({ pointerId: 1, button: 0, altKey,
    clientX: -120 + x / 800 * parseFloat(frame.style.width),
    clientY: -60 + y / 600 * parseFloat(frame.style.height) });
  const footprint = (): Point[] => JSON.parse(screen.getByTestId("workflow-footprint").textContent!);
  return { frame, pointer, footprint, user: userEvent.setup(), history: () => screen.getByTestId("workflow-history").textContent };
}

beforeEach(() => {
  mockCanvasContext();
  vi.stubGlobal("ResizeObserver", class {
    callback: () => void;
    constructor(callback: () => void) { this.callback = callback; }
    observe(element: HTMLElement) {
      Object.defineProperty(element, "clientWidth", { configurable: true, value: 832 });
      Object.defineProperty(element, "clientHeight", { configurable: true, value: 632 });
      this.callback();
    }
    disconnect() {}
  });
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperties(HTMLElement.prototype, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: () => false },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "setPointerCapture");
  Reflect.deleteProperty(HTMLElement.prototype, "hasPointerCapture");
});

describe("polygon penetration review", () => {
  it.each([false, true])("zooms to the selected boundary and recenters after panning without editing it, legacy box: %s", async legacy => {
    const { frame, user, history } = setup(false, legacy);
    const viewport = screen.getByTestId("roi-viewport");
    Object.defineProperties(viewport, {
      clientLeft: { configurable: true, value: 2 }, clientTop: { configurable: true, value: 2 },
    });
    vi.spyOn(viewport, "getBoundingClientRect").mockImplementation(() => ({
      x: 40, y: 90, left: 40, top: 90, right: 872, bottom: 722, width: 832, height: 632, toJSON: () => ({}),
    }));
    vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => {
      const width = parseFloat(frame.style.width), height = parseFloat(frame.style.height);
      const left = 42 + Math.max(0, (viewport.clientWidth - width) / 2) - viewport.scrollLeft;
      const top = 108 - viewport.scrollTop;
      return { x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) };
    });
    const beforeHistory = history(), before = screen.getByTestId("workflow-footprint").textContent;
    viewport.scrollLeft = 120; viewport.scrollTop = 90;
    await user.click(screen.getByRole("button", { name: "Zoom to Penetration" }));
    const displayScale = parseFloat(frame.style.width) / 800;
    expect(displayScale).toBeGreaterThan(1);
    expect(80 * displayScale).toBeLessThan(viewport.clientWidth);
    expect(90 * displayScale).toBeLessThan(viewport.clientHeight);
    expect(viewport.scrollLeft).toBeCloseTo(320 * displayScale - viewport.clientWidth / 2);
    expect(viewport.scrollTop).toBeCloseTo(16 + 195 * displayScale - viewport.clientHeight / 2);
    const focused = { width: frame.style.width, left: viewport.scrollLeft, top: viewport.scrollTop };
    viewport.scrollLeft = 0; viewport.scrollTop = 0;
    await user.click(screen.getByRole("button", { name: "Zoom to Penetration" }));
    expect(frame.style.width).toBe(focused.width);
    expect(viewport.scrollLeft).toBeCloseTo(focused.left);
    expect(viewport.scrollTop).toBeCloseTo(focused.top);
    expect(history()).toBe(beforeHistory);
    expect(screen.getByTestId("workflow-footprint").textContent).toBe(before);
  });

  it("rotates the actual cutout in source pixels, preserves concavity and area, and undoes the change", async () => {
    const { user, footprint, frame, pointer, history } = setup();
    expect(screen.queryByRole("spinbutton", { name: "Rotate opening by (degrees)" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add opening" }));
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    const before = footprint();
    const beforeHistory = Number(history());
    const handle = screen.getByRole("button", { name: "Rotate Penetration 1" });
    const start = { x: parseFloat(handle.style.left) * 8, y: parseFloat(handle.style.top) * 6 };
    const radius = 195 - start.y;
    const atAngle = (degrees: number) => pointer(320 + radius * Math.sin(degrees * Math.PI / 180),
      195 - radius * Math.cos(degrees * Math.PI / 180));
    const cutout = screen.getByTestId("opening-mask-penetration:rooflight:0");
    const originalCutout = cutout.getAttribute("points");
    fireEvent.pointerDown(handle, pointer(start.x, start.y));
    fireEvent.pointerMove(frame, atAngle(15));
    expect(footprint()).toEqual(before);
    expect(Number(history())).toBe(beforeHistory);
    expect(cutout.getAttribute("points")).not.toBe(originalCutout);
    fireEvent.pointerMove(frame, atAngle(30));
    fireEvent.pointerUp(frame, atAngle(30));
    expect(footprint()).toHaveLength(5);
    expect(footprint()[0].x).toBeCloseTo(307.8589838486, 6);
    expect(footprint()[0].y).toBeCloseTo(136.0288568297, 6);
    expect(penetrationArea(footprint())).toBeCloseTo(penetrationArea(before), 6);
    expect(Number(history())).toBe(beforeHistory + 1);
    expect(cutout.getAttribute("points")!.split(" ")).toHaveLength(5);
    await user.click(screen.getByRole("button", { name: "Undo review edit" }));
    expect(footprint()).toEqual(before);
    expect(cutout).toHaveAttribute("points", originalCutout);
  });

  it("snaps handle rotation by 15 degrees and keeps repeated keyboard rotation around one pivot", async () => {
    const { frame, pointer, footprint, user } = setup();
    const handle = () => screen.getByRole("button", { name: "Rotate Penetration 1" });
    fireEvent.pointerDown(handle(), pointer(320, 116));
    const position = pointer(320 + 79 * Math.sin(23 * Math.PI / 180), 195 - 79 * Math.cos(23 * Math.PI / 180));
    fireEvent.pointerMove(frame, { ...position, shiftKey: true });
    fireEvent.pointerUp(frame, { ...position, shiftKey: true });
    expect(footprint()[0].x).toBeCloseTo(307.8589838486, 6);
    await user.click(screen.getByRole("button", { name: "Undo review edit" }));
    for (let index = 0; index < 6; index++) fireEvent.keyDown(handle(), { key: "ArrowRight", shiftKey: true });
    expect(footprint()[0].x).toBeCloseTo(365, 6);
    expect(footprint()[0].y).toBeCloseTo(155, 6);
    expect(penetrationArea(footprint())).toBeCloseTo(penetrationArea(original), 6);
  });

  it("ignores clicks on the rotation handle and cancels unfinished drags", () => {
    const { frame, pointer, footprint, history } = setup();
    const handle = () => screen.getByRole("button", { name: "Rotate Penetration 1" });
    const beforeHistory = history();
    fireEvent.pointerDown(handle(), pointer(322, 118));
    fireEvent.pointerUp(frame, pointer(322, 118));
    expect(history()).toBe(beforeHistory);
    for (const cancel of [() => fireEvent.keyDown(frame, { key: "Escape" }), () => fireEvent.pointerCancel(frame),
      () => fireEvent(window, new Event("blur"))]) {
      fireEvent.pointerDown(handle(), pointer(320, 116));
      fireEvent.pointerMove(frame, pointer(399, 195));
      cancel();
      fireEvent.pointerUp(frame, pointer(399, 195));
      expect(footprint()).toEqual(original);
      expect(history()).toBe(beforeHistory);
    }
  });

  it("promotes a legacy box to a rotated polygon and restores the box with one Undo", async () => {
    const { frame, pointer, footprint, user } = setup(false, true);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Rotate Penetration 1" }), pointer(320, 116));
    fireEvent.pointerMove(frame, pointer(399, 195));
    fireEvent.pointerUp(frame, pointer(399, 195));
    expect(footprint()).toHaveLength(4);
    expect(footprint()[0].x).toBeCloseTo(365, 6);
    expect(footprint()[0].y).toBeCloseTo(155, 6);
    await user.click(screen.getByRole("button", { name: "Undo review edit" }));
    expect(screen.getByTestId("workflow-footprint")).toBeEmptyDOMElement();
  });

  it("keeps the handle on the page near an edge and rejects an off-page rotation", () => {
    const { frame, pointer, footprint, history } = setup(false, false, true);
    const handle = screen.getByRole("button", { name: "Rotate Penetration 1" });
    expect(parseFloat(handle.style.top) * 6).toBeCloseTo(54);
    const before = footprint(), beforeHistory = history();
    fireEvent.pointerDown(handle, pointer(60, 54));
    fireEvent.pointerMove(frame, pointer(16.5, 10.5));
    expect(screen.getByRole("alert")).toHaveTextContent("leave the page");
    fireEvent.pointerUp(frame, pointer(16.5, 10.5));
    expect(footprint()).toEqual(before);
    expect(history()).toBe(beforeHistory);
  });

  it("keeps a clicked vertex still, retains its grab offset while snapping, and rejects self-intersections", async () => {
    const { frame, pointer, footprint, history, user } = setup();
    await user.click(screen.getByRole("button", { name: "Edit vertices" }));
    const beforeHistory = history();
    const handle = () => screen.getByRole("button", { name: "Move Penetration 1 vertex 1" });
    fireEvent.pointerDown(handle(), pointer(283, 152));
    fireEvent.pointerUp(frame, pointer(283, 152));
    expect(footprint()).toEqual(original);
    expect(history()).toBe(beforeHistory);
    fireEvent.pointerDown(handle(), pointer(283, 152));
    fireEvent.pointerMove(frame, pointer(285, 152));
    fireEvent.pointerUp(frame, pointer(285, 152));
    expect(footprint()).toEqual(original);
    fireEvent.pointerDown(handle(), pointer(283, 152, false));
    fireEvent.pointerMove(frame, pointer(304, 163, false));
    fireEvent.pointerUp(frame, pointer(304, 163, false));
    expect(footprint()[0]).toEqual({ x: 300, y: 160 });
    const beforeInvalid = footprint();
    fireEvent.pointerDown(handle(), pointer(300, 160));
    fireEvent.pointerMove(frame, pointer(360, 240));
    expect(screen.getByRole("alert")).toHaveTextContent("cross the boundary");
    fireEvent.pointerUp(frame, pointer(360, 240));
    expect(footprint()).toEqual(beforeInvalid);
  });

  it("cancels live vertex gestures on window blur and external annotation edits", async () => {
    const { frame, pointer, footprint, user } = setup();
    await user.click(screen.getByRole("button", { name: "Edit vertices" }));
    for (const cancel of [() => fireEvent(window, new Event("blur")),
      () => fireEvent.click(screen.getByRole("button", { name: "External review" }))]) {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Move Penetration 1 vertex 1" }), pointer(280, 150));
      fireEvent.pointerMove(frame, pointer(260, 130));
      cancel();
      fireEvent.pointerUp(frame, pointer(260, 130));
      expect(footprint()).toEqual(original);
    }
  });

  it("traces an irregular manual boundary, finishes with Enter, and keeps its vertices", async () => {
    const { frame, pointer, footprint, user } = setup();
    await user.selectOptions(screen.getByRole("combobox", { name: "Opening shape" }), "polygon");
    await user.click(screen.getByRole("button", { name: "Manual penetration" }));
    const corners = [{ x: 400, y: 180 }, { x: 500, y: 180 }, { x: 500, y: 260 }, { x: 450, y: 230 }, { x: 400, y: 260 }];
    for (const corner of corners) fireEvent.pointerDown(frame, pointer(corner.x, corner.y));
    fireEvent.keyDown(frame, { key: "Enter" });
    expect(footprint()).toHaveLength(corners.length);
    footprint().forEach((point, index) => {
      expect(point.x).toBeCloseTo(corners[index].x, 8);
      expect(point.y).toBeCloseTo(corners[index].y, 8);
    });
    expect(screen.queryByLabelText("Draft penetration boundary")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add opening" }));
    expect(screen.getByTestId("opening-mask-penetration:manual:0").getAttribute("points")!.split(" ")).toHaveLength(5);
  });

  it("creates a true circle on a nonsquare page and previews clipping before acceptance", async () => {
    const { frame, pointer, footprint, user } = setup(true);
    expect(screen.getByLabelText("Proposed clipped opening")).toBeVisible();
    const preview = screen.getByTestId("proposed-opening-penetration:rooflight:0");
    expect(preview).toHaveAttribute("points", expect.stringContaining("740,"));
    expect(screen.queryByTestId("opening-mask-penetration:rooflight:0")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Opening shape" }), "circle");
    await user.click(screen.getByRole("button", { name: "Manual penetration" }));
    fireEvent.pointerDown(frame, pointer(400, 180)); fireEvent.pointerUp(frame, pointer(500, 260));
    const ring = footprint();
    expect(ring).toHaveLength(48);
    const width = Math.max(...ring.map(p => p.x)) - Math.min(...ring.map(p => p.x));
    const height = Math.max(...ring.map(p => p.y)) - Math.min(...ring.map(p => p.y));
    expect(width).toBeCloseTo(height, 8);
    expect(width).toBeCloseTo(80);
  });
});
