import { webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { capturePdfPage, readBlobBytes, sha256 } from "./roiSource";

const context = {
  document_id: "document_test", file_name: "test.pdf", page_index: 0,
  render_scale: 2, render_rotation: 90, render_version: "pdfjs-test",
  pdf_view_box: [10, 20, 610, 820],
};

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
});

describe("immutable PDF source", () => {
  it("captures stable page identity and bytes before a mutable editor canvas changes", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 1200;
    let pixels = "pristine source pixels";
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(new Blob([pixels], { type: "image/png" })));
    const page = await capturePdfPage(canvas, context);
    expect(await capturePdfPage(canvas, context)).toEqual(page);
    pixels = "painted overlay";
    canvas.width = 800;
    expect(page.source_width).toBe(1600);
    expect(page.source_blob.type).toBe("image/png");
    expect(new TextDecoder().decode(await readBlobBytes(page.source_blob))).toBe("pristine source pixels");
    expect(await sha256(await readBlobBytes(page.source_blob))).toBe(page.source_image_hash);
    expect(Object.isFrozen(page)).toBe(true);
    expect((await capturePdfPage(canvas, context)).page_id).not.toBe(page.page_id);
  });

  it("distinguishes files, pages, rotation and render versions even for identical pixels", async () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(new Blob(["pixels"])));
    const baseline = await capturePdfPage(canvas, context);
    for (const change of [{ document_id: "other" }, { page_index: 1 }, { render_rotation: 0 }, { render_version: "next" }]) {
      expect((await capturePdfPage(canvas, { ...context, ...change })).page_id).not.toBe(baseline.page_id);
    }
  });

  it("fails explicitly when encoding fails", async () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(null));
    await expect(capturePdfPage(canvas, context)).rejects.toThrow("capture PDF page");
  });
});