import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { rasterizeOutlinesWithHoles } from "@/utils/polygonAdjust";
import { PaintBucketCanvas } from "./PaintBucketCanvas";

it("uses the chosen sensitivity for preview and cutting without changing geometry when the slider moves", async () => {
  const width = 100, height = 80;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  // Two connected, subtly different roof surfaces: low tolerance should separate them.
  for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) {
    data.fill(245, (y * width + x) * 4, (y * width + x) * 4 + 3);
  }
  const writes = vi.fn();
  Object.assign(mockCanvasContext(), {
    getImageData: () => ({ data, width, height }),
    putImageData: writes,
    createImageData: () => ({ data: new Uint8ClampedArray(data.length), width, height }),
  });
  const source = document.createElement("canvas");
  source.width = width;
  source.height = height;
  const onOutlinesExtracted = vi.fn();
  render(<PaintBucketCanvas pdfCanvas={source} onOutlinesExtracted={onOutlinesExtracted}
    roofOutlines={[[{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 70 }, { x: 10, y: 70 }]]} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Cut Out" })).toBeEnabled());
  expect(screen.queryByRole("slider")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Cut Out" }));
  const slider = screen.getByRole("slider", { name: "Cut Out sensitivity" });
  expect(slider).toHaveValue("40");
  const canvas = screen.getByTestId("paint-interaction-canvas") as HTMLCanvasElement;
  const position = { clientX: 25 * parseFloat(canvas.style.width) / width,
    clientY: 40 * parseFloat(canvas.style.height) / height };
  const previewCount = () => {
    const frame = writes.mock.calls.at(-1)?.[0] as ImageData | undefined;
    if (!frame) return 0;
    let count = 0;
    for (let i = 0; i < frame.data.length; i += 4) {
      if (frame.data[i] === 255 && frame.data[i + 1] === 140 && frame.data[i + 2] === 0 && frame.data[i + 3] === 100) count++;
    }
    return count;
  };
  fireEvent.mouseMove(canvas, position);
  await waitFor(() => expect(previewCount()).toBeGreaterThan(4000));
  const broadPreview = previewCount();
  fireEvent.change(slider, { target: { value: "10" } });
  writes.mockClear();
  // Returning to exactly the same pixel must recompute at the new tolerance.
  fireEvent.mouseMove(canvas, position);
  await waitFor(() => expect(previewCount()).toBeGreaterThan(0));
  expect(previewCount()).toBeLessThan(broadPreview);
  expect(onOutlinesExtracted).not.toHaveBeenCalled();
  fireEvent.click(canvas, position);
  const remaining = rasterizeOutlinesWithHoles(onOutlinesExtracted.mock.lastCall![0], [], width, height);
  expect(remaining[40 * width + 25]).toBe(0);
  expect(remaining[40 * width + 75]).toBe(1);

  fireEvent.click(screen.getByRole("button", { name: "Select" }));
  fireEvent.click(screen.getByRole("button", { name: "Cut Out" }));
  expect(screen.getByRole("slider", { name: "Cut Out sensitivity" })).toHaveValue("10");
  const edits = onOutlinesExtracted.mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Default (40)" }));
  expect(screen.getByRole("slider", { name: "Cut Out sensitivity" })).toHaveValue("40");
  expect(onOutlinesExtracted).toHaveBeenCalledTimes(edits);
});
