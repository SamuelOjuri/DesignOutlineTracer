import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { PdfUpload } from "./PdfUpload";

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: () => ({ width: 600, height: 400 }),
        render: () => ({ promise: Promise.resolve() }),
      }),
    }),
  }),
}));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA==");
});

it("delivers a newly uploaded page to the current callback after a parent rerender", async () => {
  const originalCallback = vi.fn();
  const currentCallback = vi.fn();
  const props = { drawingScale: { paperSize: "A1", scaleRatio: 100 }, onDrawingScaleChange: vi.fn() };
  const { container, rerender } = render(<PdfUpload {...props} onPdfRendered={originalCallback} />);
  rerender(<PdfUpload {...props} onPdfRendered={currentCallback} />);

  const file = new File(["synthetic PDF"], "roof.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(0) });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });

  await waitFor(() => expect(currentCallback).toHaveBeenCalledOnce());
  expect(currentCallback).toHaveBeenCalledWith(expect.objectContaining({ width: 600, height: 400 }));
  expect(originalCallback).not.toHaveBeenCalled();
});