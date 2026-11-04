import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { RoofIllustrationCanvas } from "./RoofIllustrationCanvas";

it("redraws holes and drainage legend changes without resetting zoom", () => {
  const context = mockCanvasContext();
  const props: ComponentProps<typeof RoofIllustrationCanvas> = {
    roofOutlines: [[{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 400 }]],
    outlets: [], drainageEdges: [], interiorHoles: [],
  };
  const { container, rerender } = render(<RoofIllustrationCanvas {...props} />);
  const canvas = container.querySelector("canvas")!;
  const fitWidth = Number.parseFloat(canvas.style.width);
  fireEvent.click(screen.getByTitle("Zoom in"));
  const zoomedWidth = canvas.style.width;
  expect(Number.parseFloat(zoomedWidth)).toBeGreaterThan(fitWidth);
  context.moveTo.mockClear();
  context.fillText.mockClear();

  rerender(<RoofIllustrationCanvas {...props}
    interiorHoles={[[{ x: 150, y: 160 }, { x: 180, y: 160 }, { x: 180, y: 190 }]]}
    drainageEdges={[{ outlineIndex: 0, edgeIndex: 0 }]} />);

  expect(context.moveTo).toHaveBeenCalledWith(110, 120);
  expect(context.setLineDash.mock.calls.every(([dash]) => (dash as number[]).length === 0)).toBe(true);
  expect(context.fillText).toHaveBeenCalledWith("Drainage Edge", expect.any(Number), expect.any(Number));
  expect(canvas.style.width).toBe(zoomedWidth);
  context.moveTo.mockClear();
  context.fillText.mockClear();

  rerender(<RoofIllustrationCanvas {...props} />);

  expect(context.moveTo).not.toHaveBeenCalledWith(110, 120);
  expect(context.fillText).not.toHaveBeenCalledWith("Drainage Edge", expect.any(Number), expect.any(Number));
  expect(canvas.style.width).toBe(zoomedWidth);
});

const square = (left: number) => [{ x: left, y: 100 }, { x: left + 200, y: 100 }, { x: left + 200, y: 300 }, { x: left, y: 300 }];

it("drags every roof area on the grabbed page as one group, converting screen movement at the current zoom", () => {
  const context = mockCanvasContext();
  const onMoveGroup = vi.fn();
  const { container } = render(<RoofIllustrationCanvas roofOutlines={[square(100), square(400), square(700)]}
    outlineGroups={["page-1", "page-1", "page-2"]} outlets={[]} drainageEdges={[]}
    onMoveGroup={onMoveGroup} onResetLayout={vi.fn()} />);
  const canvas = container.querySelector("canvas")!;
  // Displayed at half size, so one screen pixel is two drawing units.
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: canvas.width / 2,
    height: canvas.height / 2, right: canvas.width / 2, bottom: canvas.height / 2, x: 0, y: 0, toJSON: () => ({}) });
  const hoverDashes = () => context.setLineDash.mock.calls.filter(([dash]) => (dash as number[]).length > 0).length;

  context.setLineDash.mockClear();
  fireEvent.mouseMove(canvas, { clientX: 80, clientY: 80 });
  expect(hoverDashes()).toBe(2);
  expect(canvas).toHaveClass("cursor-move");

  fireEvent.mouseDown(canvas, { button: 0, clientX: 230, clientY: 80 });
  fireEvent.mouseMove(canvas, { clientX: 240, clientY: 95 });
  fireEvent.mouseMove(canvas, { clientX: 242.5, clientY: 90 });
  expect(onMoveGroup.mock.calls).toEqual([["page-1", { x: 20, y: 30 }], ["page-1", { x: 5, y: -10 }]]);

  fireEvent.mouseUp(canvas);
  fireEvent.mouseMove(canvas, { clientX: 260, clientY: 100 });
  fireEvent.mouseDown(canvas, { button: 0, clientX: 380, clientY: 80 });
  fireEvent.mouseMove(canvas, { clientX: 390, clientY: 80 });
  expect(onMoveGroup).toHaveBeenLastCalledWith("page-2", { x: 20, y: 0 });
  expect(onMoveGroup).toHaveBeenCalledTimes(3);
});

it("offers Reset layout only while arranging is enabled, and is read-only otherwise", () => {
  mockCanvasContext();
  const onResetLayout = vi.fn();
  const props: ComponentProps<typeof RoofIllustrationCanvas> = {
    roofOutlines: [square(100), square(400)], outlineGroups: ["page-1", "page-2"], outlets: [], drainageEdges: [],
  };
  const { container, rerender } = render(<RoofIllustrationCanvas {...props} />);
  const canvas = container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: canvas.width,
    height: canvas.height, right: canvas.width, bottom: canvas.height, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.mouseMove(canvas, { clientX: 160, clientY: 160 });
  expect(canvas).not.toHaveClass("cursor-move");
  expect(screen.queryByRole("button", { name: "Reset layout" })).not.toBeInTheDocument();
  expect(screen.getByText(/Roof areas keep their positions from the plan/)).toBeInTheDocument();

  rerender(<RoofIllustrationCanvas {...props} onMoveGroup={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Reset layout" })).toBeDisabled();
  expect(screen.getByText(/Drag to arrange pages in the downloaded drawing/)).toBeInTheDocument();

  rerender(<RoofIllustrationCanvas {...props} onMoveGroup={vi.fn()} onResetLayout={onResetLayout} />);
  fireEvent.click(screen.getByRole("button", { name: "Reset layout" }));
  expect(onResetLayout).toHaveBeenCalledOnce();
});

it("uses the same screen-sized outlet glyph in the final illustration", () => {
  const context = mockCanvasContext();
  const { container } = render(<RoofIllustrationCanvas
    roofOutlines={[[{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 400 }, { x: 100, y: 400 }]]}
    outlets={[{ id: "a", x: 300, y: 200, diameter: 0.9 }]} drainageEdges={[]} />);
  const canvas = container.querySelector("canvas")!;
  let scale = Number.parseFloat(canvas.style.width) / canvas.width;
  expect(context.arc).toHaveBeenCalledWith(260, 160, expect.closeTo(10 / scale), 0, Math.PI * 2);
  context.arc.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
  scale = Number.parseFloat(canvas.style.width) / canvas.width;
  expect(context.arc).toHaveBeenCalledWith(260, 160, expect.closeTo(10 / scale), 0, Math.PI * 2);
});
