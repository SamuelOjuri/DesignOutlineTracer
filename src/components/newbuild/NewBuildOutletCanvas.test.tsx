import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { NewBuildOutletCanvas } from "./NewBuildOutletCanvas";

function createProps(): ComponentProps<typeof NewBuildOutletCanvas> {
  const pdfCanvas = document.createElement("canvas");
  pdfCanvas.width = 800;
  pdfCanvas.height = 600;
  return {
    pdfCanvas,
    roofOutlines: [[{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 400 }]],
    interiorHoles: [], outlets: [], selectedOutlet: null, drainageEdges: [],
    outletMode: "add-outlets",
    onAddOutlet: vi.fn(), onSelectOutlet: vi.fn(), onMoveOutlet: vi.fn(), onToggleDrainageEdge: vi.fn(),
  };
}

it("redraws a hole-only update without resizing the canvas or resetting zoom", () => {
  const context = mockCanvasContext();
  const props = createProps();
  const { container, rerender } = render(<NewBuildOutletCanvas {...props} />);
  const canvas = container.querySelector("canvas")!;
  fireEvent.click(screen.getByTitle("Zoom in"));
  expect(Number.parseFloat(canvas.style.width)).toBeCloseTo(920);
  context.moveTo.mockClear();

  rerender(<NewBuildOutletCanvas {...props} interiorHoles={[[{ x: 150, y: 160 }, { x: 180, y: 160 }, { x: 180, y: 190 }]]} />);

  expect(context.moveTo).toHaveBeenCalledWith(150, 160);
  expect(context.fill).toHaveBeenCalledWith("evenodd");
  expect(canvas.width).toBe(800);
  expect(Number.parseFloat(canvas.style.width)).toBeCloseTo(920);
});

it("resizes and redraws when only the source page changes", () => {
  const context = mockCanvasContext();
  const props = createProps();
  const { container, rerender } = render(<NewBuildOutletCanvas {...props} />);
  const replacement = document.createElement("canvas");
  replacement.width = 400;
  replacement.height = 300;
  context.drawImage.mockClear();

  rerender(<NewBuildOutletCanvas {...props} pdfCanvas={replacement} />);

  expect(context.drawImage).toHaveBeenCalledWith(replacement, 0, 0);
  expect(container.querySelector("canvas")!.width).toBe(400);
  expect(container.querySelector("canvas")!.height).toBe(300);
});

it("redraws constant-screen markers on zoom while retaining source coordinates", () => {
  const context = mockCanvasContext();
  const props = createProps();
  const outlet = { id: "o1", x: 100, y: 100, diameter: 0.15 };
  const { container } = render(<NewBuildOutletCanvas {...props} outlets={[outlet]} />);
  expect(context.arc).toHaveBeenCalledWith(100, 100, 10, 0, Math.PI * 2);
  context.arc.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  expect(context.arc).toHaveBeenCalledWith(100, 100, expect.closeTo(10 / 1.15), 0, Math.PI * 2);
  expect(Number.parseFloat(container.querySelector("canvas")!.style.width)).toBeCloseTo(920);
  expect(props.onMoveOutlet).not.toHaveBeenCalled();
});

it("keeps a screen-sized target at low zoom and selects the nearest overlapping marker", () => {
  mockCanvasContext();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(176);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(136);
  const props = createProps();
  const outlets = [{ id: "far", x: 100, y: 100, diameter: 0.15 }, { id: "near", x: 150, y: 100, diameter: 0.15 }];
  const { container } = render(<NewBuildOutletCanvas {...props} outlets={outlets} outletMode="select" />);
  // At 20%, x=38 is 8 screen pixels from 'near' but 18 from 'far'.
  fireEvent.mouseDown(container.querySelector("canvas")!, { button: 0, clientX: 38, clientY: 20 });
  expect(props.onSelectOutlet).toHaveBeenCalledWith(outlets[1]);
  expect(props.onAddOutlet).not.toHaveBeenCalled();
});

it("previews a drag locally and commits once on leave without adding accidental outlets", () => {
  const context = mockCanvasContext();
  const props = createProps();
  const outlet = { id: "o1", x: 100, y: 100, diameter: 0.15 };
  const { container } = render(<NewBuildOutletCanvas {...props} outlets={[outlet]} outletMode="select" />);
  const canvas = container.querySelector("canvas")!;
  fireEvent.mouseDown(canvas, { button: 0, clientX: 300, clientY: 300 });
  expect(props.onAddOutlet).not.toHaveBeenCalled();
  fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(canvas, { clientX: 105, clientY: 110 });
  context.arc.mockClear();
  fireEvent.mouseMove(canvas, { clientX: 110.5, clientY: 120.25 });
  expect(props.onMoveOutlet).not.toHaveBeenCalled();
  expect(context.arc).toHaveBeenCalledWith(110.5, 120.25, expect.any(Number), 0, Math.PI * 2);
  expect(outlet).toMatchObject({ x: 100, y: 100 });
  fireEvent.mouseLeave(canvas);
  expect(props.onMoveOutlet).toHaveBeenCalledTimes(1);
  expect(props.onMoveOutlet).toHaveBeenLastCalledWith("o1", 110.5, 120.25);
  vi.mocked(props.onMoveOutlet).mockClear();
  fireEvent.mouseMove(canvas, { clientX: 140, clientY: 150 });
  expect(props.onMoveOutlet).not.toHaveBeenCalled();
});

it("commits one move on mouseup and does not create a second move on leave or a click", () => {
  mockCanvasContext();
  const props = createProps();
  const outlet = { id: "o1", x: 100, y: 100, diameter: 0.15 };
  const { container } = render(<NewBuildOutletCanvas {...props} outlets={[outlet]} outletMode="select" />);
  const canvas = container.querySelector("canvas")!;
  fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(canvas, { clientX: 105, clientY: 110 });
  fireEvent.mouseMove(canvas, { clientX: 120, clientY: 130 });
  expect(props.onMoveOutlet).not.toHaveBeenCalled();
  fireEvent.mouseUp(canvas);
  fireEvent.mouseLeave(canvas);
  expect(props.onMoveOutlet).toHaveBeenCalledTimes(1);
  expect(props.onMoveOutlet).toHaveBeenLastCalledWith("o1", 120, 130);
  fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseUp(canvas);
  expect(props.onMoveOutlet).toHaveBeenCalledTimes(1);
});

it("Escape discards the drag preview and restores the original anchor without a history update", () => {
  const context = mockCanvasContext();
  const props = createProps();
  const outlet = { id: "o1", x: 100, y: 100, diameter: 0.15 };
  const { container } = render(<NewBuildOutletCanvas {...props} outlets={[outlet]} outletMode="select" />);
  const canvas = container.querySelector("canvas")!;
  fireEvent.mouseDown(canvas, { button: 0, clientX: 100, clientY: 100 });
  fireEvent.mouseMove(canvas, { clientX: 120, clientY: 130 });
  context.arc.mockClear();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(context.arc).toHaveBeenCalledWith(100, 100, 10, 0, Math.PI * 2);
  fireEvent.mouseUp(canvas);
  fireEvent.mouseLeave(canvas);
  expect(props.onMoveOutlet).not.toHaveBeenCalled();
  expect(outlet).toMatchObject({ x: 100, y: 100 });
});

it("zooms to a selected tiny outlet without changing its position", () => {
  mockCanvasContext();
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(176);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(136);
  const props = createProps();
  const outlet = { id: "o1", x: 110, y: 105, diameter: 0.15 };
  const { container } = render(<NewBuildOutletCanvas {...props} outlets={[outlet]} selectedOutlet={outlet} />);
  const canvas = container.querySelector("canvas")!;
  expect(Number.parseFloat(canvas.style.width)).toBe(160);
  fireEvent.click(screen.getByRole("button", { name: "Zoom to outlet" }));
  expect(Number.parseFloat(canvas.style.width)).toBeGreaterThanOrEqual(800);
  expect(props.onMoveOutlet).not.toHaveBeenCalled();
});
