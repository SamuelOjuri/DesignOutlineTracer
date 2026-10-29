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
  expect(context.fillText).toHaveBeenCalledWith("Drainage Edge", expect.any(Number), expect.any(Number));
  expect(canvas.style.width).toBe(zoomedWidth);
  context.moveTo.mockClear();
  context.fillText.mockClear();

  rerender(<RoofIllustrationCanvas {...props} />);

  expect(context.moveTo).not.toHaveBeenCalledWith(110, 120);
  expect(context.fillText).not.toHaveBeenCalledWith("Drainage Edge", expect.any(Number), expect.any(Number));
  expect(canvas.style.width).toBe(zoomedWidth);
});

it("moves a boundary outlet with its assigned roof, without taking the neighbouring roof's outlet", () => {
  mockCanvasContext();
  const roofA = [{ x: 100, y: 100 }, { x: 500, y: 100 }, { x: 500, y: 400 }, { x: 100, y: 400 }];
  const roofB = [{ x: 500, y: 100 }, { x: 800, y: 100 }, { x: 800, y: 400 }, { x: 500, y: 400 }];
  const outlets = [{ id: "a", x: 500, y: 200, diameter: 0.15, outline_id: "roof-a" },
    { id: "b", x: 500, y: 200, diameter: 0.15, outline_id: "roof-b" }];
  const onOutletsChange = vi.fn();
  const { container } = render(<RoofIllustrationCanvas roofOutlines={[roofA, roofB]}
    outlineIds={["roof-a", "roof-b"]} outlets={outlets} drainageEdges={[]}
    onOutlinesChange={vi.fn()} onOutletsChange={onOutletsChange} />);
  const canvas = container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: canvas.width,
    height: canvas.height, right: canvas.width, bottom: canvas.height, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.mouseDown(canvas, { button: 0, clientX: 260, clientY: 160 });
  fireEvent.mouseMove(canvas, { clientX: 280, clientY: 190 });
  expect(onOutletsChange).toHaveBeenLastCalledWith([
    { ...outlets[0], x: 520, y: 230 }, outlets[1],
  ]);
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

it("preserves fractional anchors on angled edges when translating a roof and its openings", () => {
  mockCanvasContext();
  const roof = [{ x: 100.25, y: 100.5 }, { x: 500.25, y: 100.5 }, { x: 500.25, y: 400.5 }];
  const hole = [{ x: 350.125, y: 150.25 }, { x: 370.125, y: 150.25 }, { x: 370.125, y: 170.25 }];
  const outlet = { id: "a", x: 300.25, y: 250.5, diameter: 0.15, outline_id: "roof-a" };
  const onOutlinesChange = vi.fn(), onHolesChange = vi.fn(), onOutletsChange = vi.fn();
  const { container } = render(<RoofIllustrationCanvas roofOutlines={[roof]} outlineIds={["roof-a"]}
    outlets={[outlet]} interiorHoles={[hole]} drainageEdges={[]} onOutlinesChange={onOutlinesChange}
    onHolesChange={onHolesChange} onOutletsChange={onOutletsChange} />);
  const canvas = container.querySelector("canvas")!;
  vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: canvas.width,
    height: canvas.height, right: canvas.width, bottom: canvas.height, x: 0, y: 0, toJSON: () => ({}) });
  fireEvent.mouseDown(canvas, { button: 0, clientX: 360, clientY: 160 });
  fireEvent.mouseMove(canvas, { clientX: 380.125, clientY: 190.375 });
  const translate = (point: { x: number; y: number }) => ({ x: point.x + 20.125, y: point.y + 30.375 });
  expect(onOutlinesChange).toHaveBeenLastCalledWith([roof.map(translate)]);
  expect(onHolesChange).toHaveBeenLastCalledWith([hole.map(translate)]);
  expect(onOutletsChange).toHaveBeenLastCalledWith([{ ...outlet, ...translate(outlet) }]);
  const moved = onOutletsChange.mock.lastCall![0][0];
  const edge = onOutlinesChange.mock.lastCall![0][0];
  expect((moved.x - edge[0].x) * (edge[2].y - edge[0].y)
    - (moved.y - edge[0].y) * (edge[2].x - edge[0].x)).toBeCloseTo(0);
});
