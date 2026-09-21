import { useReducer, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { penetrationSession } from "@/test/penetrations";
import { syntheticAnnotation } from "@/test/roi";
import { roiSessionReducer } from "@/utils/roiSession";
import { RoiReviewCanvas } from "./RoiReviewCanvas";
import { RoiReviewSidebar } from "./RoiReviewSidebar";

function Editor({ canvas }: { canvas: HTMLCanvasElement }) {
  const [state, dispatch] = useReducer(roiSessionReducer, undefined, penetrationSession);
  const [selected, select] = useState("rooflight");
  const [adding, setAdding] = useState(false);
  const page = state.pages["page-1"];
  const annotations = page.annotations.filter(annotation => annotation.kind === "penetration");
  return <>
    <RoiReviewSidebar kind="penetration" page={page} selectedId={selected} adding={adding}
      onSelect={select} onAddingChange={setAdding} dispatch={dispatch}
      detection={{ busy: false, cancel: vi.fn(), detect: vi.fn(), feedback: undefined }} />
    <RoiReviewCanvas kind="penetration" page={page} pdfCanvas={canvas} annotations={annotations}
      selectedId={selected} adding={adding} onSelect={select} onAddingChange={setAdding}
      onEdit={(id, box_2d) => dispatch({ type: "review", page_id: "page-1", id, patch: { box_2d } })}
      onAdd={box_2d => {
        dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation("manual", {
          kind: "penetration", subtype: "vent", roi_id: "parent", review_status: "suggested", box_2d,
        }) });
        select("manual"); setAdding(false);
      }} />
    <output data-testid="committed-box">{JSON.stringify(annotations.find(annotation => annotation.id === selected)?.box_2d)}</output>
  </>;
}

function setup() {
  const canvas = document.createElement("canvas");
  canvas.width = 800; canvas.height = 600;
  render(<Editor canvas={canvas} />);
  const frame = screen.getByTestId("roi-source-canvas").parentElement!;
  // A scrolled page at any zoom: all gesture positions are relative to its displayed bounds.
  vi.spyOn(frame, "getBoundingClientRect").mockImplementation(() => ({
    x: -120, y: -60, left: -120, top: -60, right: 0, bottom: 0,
    width: parseFloat(frame.style.width), height: parseFloat(frame.style.height), toJSON: () => ({}),
  }));
  const pointer = (x: number, y: number) => ({
    pointerId: 1, button: 0,
    clientX: -120 + x / 1000 * parseFloat(frame.style.width),
    clientY: -60 + y / 1000 * parseFloat(frame.style.height),
  });
  const opening = () => screen.queryByTestId("opening-mask-penetration:rooflight:0");
  const box = () => JSON.parse(screen.getByTestId("committed-box").textContent!);
  return { frame, pointer, opening, box, user: userEvent.setup() };
}

beforeEach(() => {
  mockCanvasContext();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("PointerEvent", MouseEvent);
  // jsdom has no pointer capture; the real pointer handlers and geometry still run.
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

describe("penetration opening gestures", () => {
  it("previews and commits move/resize at zoom with Undo, and cancels unfinished drags", async () => {
    const { frame, pointer, opening, box, user } = setup();
    expect(opening()).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add opening" }));
    const original = opening()!.getAttribute("points");
    await user.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Penetration 1: accepted" }), pointer(400, 325));
    fireEvent.pointerMove(frame, pointer(450, 375));
    expect(opening()).toHaveAttribute("points", expect.stringContaining("320,180"));
    expect(box()).toEqual([250, 350, 400, 450]);
    fireEvent.pointerUp(frame, pointer(450, 375));
    expect(box()).toEqual([300, 400, 450, 500]);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Resize Penetration 1 se" }), pointer(500, 450));
    fireEvent.pointerMove(frame, pointer(550, 500));
    fireEvent.pointerUp(frame, pointer(550, 500));
    expect(box()).toEqual([300, 400, 500, 550]);
    expect(opening()).toHaveAttribute("points", expect.stringContaining("440,300"));
    await user.click(screen.getByRole("button", { name: "Undo review edit" }));
    expect(box()).toEqual([300, 400, 450, 500]);
    await user.click(screen.getByRole("button", { name: "Undo review edit" }));
    expect(opening()).toHaveAttribute("points", original);
    for (const cancel of [() => fireEvent.keyDown(frame, { key: "Escape" }), () => fireEvent.pointerCancel(frame)]) {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Penetration 1: accepted" }), pointer(400, 325));
      fireEvent.pointerMove(frame, pointer(500, 425));
      expect(opening()!.getAttribute("points")).not.toBe(original);
      cancel();
      fireEvent.pointerUp(frame, pointer(500, 425));
      expect(box()).toEqual([250, 350, 400, 450]);
      expect(opening()).toHaveAttribute("points", original);
    }
  });

  it("draws a manual suggestion, adds its opening, and removes/restores it through Delete and Undo", async () => {
    const { frame, pointer, box, user } = setup();
    await user.click(screen.getByRole("button", { name: "Manual penetration" }));
    fireEvent.pointerDown(frame, pointer(500, 300));
    expect(frame).toHaveFocus();
    fireEvent.pointerMove(frame, pointer(600, 400));
    fireEvent.pointerUp(frame, pointer(600, 400));
    expect(box()).toEqual([300, 500, 400, 600]);
    expect(screen.queryByTestId("opening-mask-penetration:manual:0")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add opening" }));
    expect(screen.getByTestId("opening-mask-penetration:manual:0")).toHaveAttribute("points", expect.stringContaining("400,180"));
    await user.click(screen.getByRole("button", { name: "Delete penetration" }));
    expect(screen.queryByTestId("opening-mask-penetration:manual:0")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Undo review edit" }));
    expect(screen.getByTestId("opening-mask-penetration:manual:0")).toBeInTheDocument();
  });

  it("explains why boxes wholly outside the insulation cannot be added", async () => {
    const { frame, pointer, user } = setup();
    await user.click(screen.getByRole("button", { name: "Manual penetration" }));
    fireEvent.pointerDown(frame, pointer(950, 900));
    fireEvent.pointerUp(frame, pointer(980, 980));
    expect(screen.getByRole("button", { name: "Add opening" })).toBeDisabled();
    expect(screen.getByText("Move or resize this box into the insulation scope, outside existing cutouts.")).toBeVisible();
  });
});
