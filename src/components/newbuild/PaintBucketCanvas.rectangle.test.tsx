import { useState } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { rasterizeOutlinesWithHoles } from "@/utils/polygonAdjust";
import type { Point } from "@/types/roof";
import { PaintBucketCanvas } from "./PaintBucketCanvas";

const width = 400, height = 300;
const box = (left: number, top: number, right: number, bottom: number): Point[] => [
  { x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom },
];
const main = box(40, 150, 350, 280);
const initialOutlines = [main, box(120, 45, 145, 70), box(270, 45, 295, 70)];
const initialHoles = [box(274, 49, 291, 66), box(80, 190, 105, 215)];

beforeEach(() => {
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) { super(type, init); this.pointerId = init.pointerId ?? 1; }
  });
  const captured = new Set<number>();
  Object.assign(HTMLCanvasElement.prototype, {
    setPointerCapture: vi.fn((id: number) => captured.add(id)),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: vi.fn((id: number) => captured.delete(id)),
  });
});

async function setup() {
  const writes = vi.fn();
  Object.assign(mockCanvasContext(), {
    getImageData: () => ({ data: new Uint8ClampedArray(width * height * 4).fill(255), width, height }),
    putImageData: writes,
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
  });
  const source = document.createElement("canvas");
  source.width = width; source.height = height;
  const outlinesChanged = vi.fn(), holesChanged = vi.fn();
  function Editor() {
    const [outlines, setOutlines] = useState(initialOutlines);
    const [holes, setHoles] = useState(initialHoles);
    return <PaintBucketCanvas pdfCanvas={source} roofOutlines={outlines} interiorHoles={holes}
      onOutlinesExtracted={(next) => { outlinesChanged(next); setOutlines(next); }}
      onHolesExtracted={(next) => { holesChanged(next); setHoles(next); }} />;
  }
  render(<Editor />);
  const tool = screen.getByRole("button", { name: "Cut Out rectangle" });
  await waitFor(() => expect(tool).toBeEnabled());
  fireEvent.click(tool);
  const canvas = screen.getByTestId("paint-interaction-canvas") as HTMLCanvasElement;
  const event = (type: "pointerDown" | "pointerMove" | "pointerUp", x: number, y: number) => {
    const bounds = canvas.getBoundingClientRect();
    fireEvent[type](canvas, { pointerId: 7, button: 0,
      clientX: bounds.left + x * parseFloat(canvas.style.width) / width,
      clientY: bounds.top + y * parseFloat(canvas.style.height) / height });
  };
  const mask = () => rasterizeOutlinesWithHoles(outlinesChanged.mock.lastCall![0], holesChanged.mock.lastCall![0], width, height);
  return { canvas, event, writes, outlinesChanged, holesChanged, mask };
}

it("previews and removes multiple remnants from empty space in either drag direction, preserves the roof and undoes exactly", async () => {
  const { canvas, event, writes, outlinesChanged, holesChanged, mask } = await setup();
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  event("pointerDown", 310, 90);
  event("pointerMove", 100, 30);
  await waitFor(() => {
    const image = writes.mock.lastCall?.[0] as ImageData;
    expect(image?.width).toBe(210);
    expect(image?.height).toBe(60);
    expect(Array.from(image.data.slice(((50 - 30) * 210 + 125 - 100) * 4, ((50 - 30) * 210 + 125 - 100) * 4 + 4))).toEqual([255, 140, 0, 100]);
    expect(image.data[((55 - 30) * 210 + 282 - 100) * 4 + 3]).toBe(0); // Empty ring centre.
  });
  expect(outlinesChanged).not.toHaveBeenCalled();
  event("pointerUp", 100, 30);
  fireEvent.click(canvas); // The click following a pointer release must not flood-fill.
  expect(outlinesChanged).toHaveBeenCalledTimes(1);
  expect(outlinesChanged.mock.lastCall![0]).toHaveLength(1);
  expect(mask()).toEqual(rasterizeOutlinesWithHoles([main], [initialHoles[1]], width, height));
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(outlinesChanged.mock.lastCall![0]).toEqual(initialOutlines);
  expect(holesChanged.mock.lastCall![0]).toEqual(initialHoles);
  event("pointerDown", 100, 30);
  event("pointerUp", 310, 90);
  expect(outlinesChanged.mock.lastCall![0]).toHaveLength(1);
});

it("cancels on Escape, tool change and lost capture; clicks and empty rectangles do not edit or add undo entries", async () => {
  const { canvas, event, outlinesChanged } = await setup();
  event("pointerDown", 100, 30); event("pointerMove", 310, 90);
  fireEvent.keyDown(window, { key: "Escape" });
  event("pointerUp", 310, 90);
  event("pointerDown", 100, 30);
  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  event("pointerUp", 310, 90);
  fireEvent.click(screen.getByRole("button", { name: "Cut Out rectangle" }));
  event("pointerDown", 100, 30);
  fireEvent.lostPointerCapture(canvas, { pointerId: 7 });
  event("pointerUp", 310, 90);
  event("pointerDown", 130, 55); event("pointerUp", 130, 55);
  event("pointerDown", 10, 10); event("pointerUp", 30, 30);
  expect(outlinesChanged).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
});

it("cuts only the overlapping roof, including a small interior hole, at zoom and scroll offsets and clips outside the page", async () => {
  const { canvas, event, mask } = await setup();
  fireEvent.click(screen.getByTitle("Zoom in"));
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: -140, top: -80 } as DOMRect);
  event("pointerDown", 200, 200); event("pointerUp", 210, 210);
  expect(mask()[205 * width + 205]).toBe(0); // Smaller than flood-fill's normal hole cleanup threshold.
  expect(mask()[205 * width + 220]).toBe(1);
  event("pointerDown", 300, 100);
  fireEvent.mouseLeave(canvas); // Moving outside must not commit before release.
  event("pointerUp", 450, 350);
  expect(mask()[200 * width + 320]).toBe(0);
  expect(mask()[200 * width + 290]).toBe(1);
  expect(mask()[205 * width + 205]).toBe(0);
});
