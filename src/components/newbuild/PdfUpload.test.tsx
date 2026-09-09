import { webcrypto } from "node:crypto";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockCanvasContext } from "@/test/canvas";
import { readBlobBytes } from "@/utils/roiSource";
import { PdfUpload } from "./PdfUpload";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn() }));
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, version: "test", getDocument: mocks.getDocument }));

function pdfDocument(renderPromise = Promise.resolve()) {
  return {
    promise: Promise.resolve({
      numPages: 2,
      getPage: vi.fn(async (pageNumber: number) => ({
        getViewport: () => ({ width: 800, height: 600 * pageNumber, scale: 2, rotation: 90, viewBox: [10, 20, 310, 420] }),
        render: () => ({ promise: renderPromise, cancel: vi.fn() }),
      })),
    }),
    destroy: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  mockCanvasContext();
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA==");
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (callback) {
    callback(new Blob([`pristine:${this.width}:${this.height}`], { type: "image/png" }));
  });
  mocks.getDocument.mockReset().mockImplementation(() => pdfDocument());
});

describe("PDF page context callback", () => {
  it("retains the legacy callback and captures an unannotated, rotated page before it runs", async () => {
    const onPageRendered = vi.fn();
    const onPdfRendered = vi.fn((canvas: HTMLCanvasElement) => { canvas.width = 1; });
    const { container } = render(<PdfUpload onPdfRendered={onPdfRendered} onPageRendered={onPageRendered}
      drawingScale={{ paperSize: "A1", scaleRatio: 100 }} onDrawingScaleChange={vi.fn()} />);
    fireEvent.change(container.querySelector("input[type=file]")!, { target: { files: [new File(["pdf"], "roof.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(onPageRendered).toHaveBeenCalledTimes(1));
    const source = onPageRendered.mock.calls[0][0];
    expect(source).toMatchObject({ file_name: "roof.pdf", page_index: 0, source_width: 800, source_height: 600, render_rotation: 90, render_scale: 2 });
    expect(new TextDecoder().decode(await readBlobBytes(source.source_blob))).toBe("pristine:800:600");
    expect(onPdfRendered).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "\u2192" }));
    await waitFor(() => expect(onPageRendered).toHaveBeenCalledTimes(2));
    expect(onPageRendered.mock.calls[1][0]).toMatchObject({ document_id: source.document_id, page_index: 1, source_height: 1200 });
    expect(onPageRendered.mock.calls[1][0].page_id).not.toBe(source.page_id);
  });

  it("ignores an old render after another file is selected", async () => {
    let finishOld!: () => void;
    const pending = new Promise<void>((resolve) => { finishOld = resolve; });
    mocks.getDocument.mockImplementationOnce(() => pdfDocument(pending));
    const onPageRendered = vi.fn();
    const onPdfRendered = vi.fn();
    const { container } = render(<PdfUpload onPdfRendered={onPdfRendered} onPageRendered={onPageRendered}
      drawingScale={{ paperSize: "A1", scaleRatio: 100 }} onDrawingScaleChange={vi.fn()} />);
    const input = container.querySelector("input[type=file]")!;
    fireEvent.change(input, { target: { files: [new File(["old"], "old.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(mocks.getDocument).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { files: [new File(["new"], "new.pdf", { type: "application/pdf" })] } });
    await waitFor(() => expect(onPageRendered).toHaveBeenCalledTimes(1));
    await act(async () => finishOld());
    expect(onPageRendered).toHaveBeenCalledTimes(1);
    expect(onPageRendered.mock.calls[0][0].file_name).toBe("new.pdf");
    expect(onPdfRendered).toHaveBeenCalledTimes(1);
  });
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
  expect(currentCallback).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600 }));
  expect(originalCallback).not.toHaveBeenCalled();
});