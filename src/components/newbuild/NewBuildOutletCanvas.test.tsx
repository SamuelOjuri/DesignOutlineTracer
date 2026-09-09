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