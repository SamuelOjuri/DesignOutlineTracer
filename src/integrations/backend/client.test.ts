import { afterEach, describe, expect, it, vi } from "vitest";
import { runAutomatedExtraction } from "./client";

afterEach(() => vi.unstubAllGlobals());

describe("automated raster extraction", () => {
  it.each([undefined, 2])("uses raster extraction for page index %s", async (pageIndex) => {
    const rasterResult = {
      document_id: "document-1",
      pipeline: "raster_first",
      render: { page_index: pageIndex ?? 0 },
      production_schema: { target_area: { outer_polygon_mm: [[10, 20], [30, 20], [30, 40]] } },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ document_id: "document-1" })))
      .mockResolvedValueOnce(new Response(JSON.stringify(rasterResult)));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["pdf"], "roof.pdf", { type: "application/pdf" });

    const result = await runAutomatedExtraction(file, pageIndex);

    expect(result).toEqual(rasterResult);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/documents$/);
    const uploadBody = fetchMock.mock.calls[0][1].body as FormData;
    expect((uploadBody.get("file") as File).name).toBe("roof.pdf");
    expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/documents\/document-1\/extract$/);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      force_pipeline: "raster_first",
      page_index: pageIndex ?? 0,
    });
  });

  it.each([-1, 1.5, NaN])("rejects invalid page index %s before uploading", async (pageIndex) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(runAutomatedExtraction(new File([], "roof.pdf"), pageIndex)).rejects.toThrow("page index");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates raster errors without attempting vector extraction", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ document_id: "document-1" })))
      .mockResolvedValueOnce(new Response("page_index is out of range", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(runAutomatedExtraction(new File([], "roof.pdf"), 9)).rejects.toThrow("Backend 422");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});