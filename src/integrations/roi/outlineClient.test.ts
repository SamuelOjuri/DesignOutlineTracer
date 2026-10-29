import { describe, expect, it, vi } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { outlineRequest, outlineResponse } from "@/test/outline";
import { initialRoiState, roiSessionReducer } from "@/utils/roiSession";
import { createRoiClient } from "./client";

function fixture() {
  const page = { ...syntheticPage(), source_image_hash: "a".repeat(64),
    vector_segments: [{ start: { x: 200, y: 100 }, end: { x: 300, y: 100 } }] };
  let state = roiSessionReducer(initialRoiState, { type: "activate", source: page, scale: { paperSize: "A1", scaleRatio: 50 } });
  state = roiSessionReducer(state, { type: "add", page_id: page.page_id, annotation: syntheticAnnotation() });
  const request = outlineRequest(state.pages[page.page_id]);
  const fetcher = vi.fn<typeof fetch>();
  const client = createRoiClient({ enabled: true, baseUrl: "http://127.0.0.1:8080", fetch: fetcher });
  return { page, request, fetcher, client };
}
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

describe("outline API client", () => {
  it("uploads the pristine image without putting vector evidence into strict page identity", async () => {
    const { page, client, fetcher } = fixture();
    const { source_blob: sourceBlob, vector_segments: vectorSegments, ...context } = page;
    fetcher.mockResolvedValueOnce(response({ page: context, upload_id: "upload", expires_in_seconds: 100 }));
    await client.uploadPage(page);
    const form = fetcher.mock.calls[0][1]?.body as FormData;
    expect(JSON.parse(form.get("context") as string)).toEqual(context);
    expect((form.get("image") as Blob).size).toBe(sourceBlob.size);
    expect(vectorSegments.length).toBe(1);
  });
  it("checks outline response identity independently of valid geometry", async () => {
    const { request, client, fetcher } = fixture();
    fetcher.mockResolvedValueOnce(response({ ...outlineResponse(request), geometry_revision: 99 }));
    await expect(client.generateOutline(request)).rejects.toMatchObject({ code: "response_identity_mismatch" });
  });
  it("rejects mismatched edge evidence and an inconsistent response status", async () => {
    const { request, client, fetcher } = fixture();
    const malformed = outlineResponse(request);
    malformed.proposals[0].edges[0].index = 4;
    fetcher.mockResolvedValueOnce(response(malformed));
    await expect(client.generateOutline(request)).rejects.toMatchObject({ code: "invalid_contract" });
    fetcher.mockResolvedValueOnce(response({ ...outlineResponse(request), status: "no_outline" }));
    await expect(client.generateOutline(request)).rejects.toMatchObject({ code: "invalid_contract" });
  });
  it("does not dispatch aborted outline requests", async () => {
    const { request, client, fetcher } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(client.generateOutline(request, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
