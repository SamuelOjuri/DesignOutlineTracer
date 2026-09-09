import type { ComponentProps } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
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
  expect(context.fillText).toHaveBeenCalledWith("Drainage Edge", expect.any(Number), expect.any(Number));
  expect(canvas.style.width).toBe(zoomedWidth);
  context.moveTo.mockClear();
  context.fillText.mockClear();

  rerender(<RoofIllustrationCanvas {...props} />);

  expect(context.moveTo).not.toHaveBeenCalledWith(110, 120);
  expect(context.fillText).not.toHaveBeenCalledWith("Drainage Edge", expect.any(Number), expect.any(Number));
  expect(canvas.style.width).toBe(zoomedWidth);
});