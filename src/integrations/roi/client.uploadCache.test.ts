import { afterEach, describe, expect, it, vi } from "vitest";
import { syntheticPage } from "@/test/roi";
import { createRoiClient } from "./client";

const page = { ...syntheticPage(), source_image_hash: "a".repeat(64) };
const { source_blob, ...context } = page;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const receipt = (upload_id = "upload", expires_in_seconds = 900) => ({ page: context, upload_id, expires_in_seconds });
const setup = () => {
  const fetcher = vi.fn<typeof fetch>();
  return { fetcher, client: createRoiClient({ enabled: true, baseUrl: "http://localhost:8091", fetch: fetcher }) };
};

afterEach(() => vi.restoreAllMocks());

describe("page upload receipt reuse", () => {
  it("reuses the same immutable source and returns detached receipts with remaining TTL", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(response(receipt()));
    const first = await client.uploadPage(page);
    first.page.pdf_view_box[0] = 99;
    first.upload_id = "mutated";
    now.mockReturnValue(61_000);
    const second = await client.uploadPage({ ...page, vector_segments: [] });
    expect(second).toEqual(receipt("upload", 840));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("expires from upload start rather than extending the server TTL on reuse", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const { client, fetcher } = setup();
    fetcher.mockImplementationOnce(async () => { now.mockReturnValue(9_000); return response(receipt("first", 10)); });
    await client.uploadPage(page);
    now.mockReturnValue(10_000);
    fetcher.mockResolvedValueOnce(response(receipt("second")));
    expect((await client.uploadPage(page)).upload_id).toBe("second");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("validates changed context and does not reuse a different blob with the same claimed hash", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(response(receipt()));
    await client.uploadPage(page);
    fetcher.mockResolvedValueOnce(response(receipt()));
    await expect(client.uploadPage({ ...page, render_version: "changed" })).rejects.toMatchObject({ code: "response_identity_mismatch" });
    fetcher.mockResolvedValueOnce(response({ error: { code: "source_identity_mismatch", retryable: false } }, 409));
    await expect(client.uploadPage({ ...page, source_blob: new Blob(["changed bytes"]) })).rejects.toMatchObject({ code: "source_identity_mismatch" });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("still rejects aborted and invalid requests on a cache hit", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(response(receipt()));
    await client.uploadPage(page);
    const controller = new AbortController();
    controller.abort();
    await expect(client.uploadPage(page, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.uploadPage({ ...page, render_scale: 0 })).rejects.toMatchObject({ code: "invalid_contract" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not share receipts between client sessions", async () => {
    const { client, fetcher } = setup();
    const other = createRoiClient({ enabled: true, baseUrl: "http://localhost:8091", fetch: fetcher });
    fetcher.mockImplementation(async () => response(receipt()));
    await client.uploadPage(page);
    await other.uploadPage(page);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].headers).not.toEqual(fetcher.mock.calls[1][1].headers);
  });

  it("invalidates a receipt when the server has lost the page", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(response(receipt()));
    await client.uploadPage(page);
    fetcher.mockResolvedValueOnce(response({ error: { code: "page_not_found", retryable: false } }, 404));
    await expect(client.detect({ page_id: page.page_id, request_id: "request", task: "roof_roi",
      source_image_hash: page.source_image_hash, roi_revision: null, geometry_revision: 0 })).rejects.toMatchObject({ code: "page_not_found" });
    fetcher.mockResolvedValueOnce(response(receipt("replacement")));
    expect((await client.uploadPage(page)).upload_id).toBe("replacement");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("invalidates the receipt on deletion", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(response(receipt()));
    await client.uploadPage(page);
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.deletePage(page.page_id);
    fetcher.mockResolvedValueOnce(response(receipt("replacement")));
    expect((await client.uploadPage(page)).upload_id).toBe("replacement");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps concurrent callers' cancellation independent", async () => {
    const { client, fetcher } = setup();
    fetcher.mockImplementation((_url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      if (fetcher.mock.calls.length === 2) resolve(response(receipt()));
    }));
    const controller = new AbortController();
    const first = client.uploadPage(page, controller.signal);
    const second = client.uploadPage(page);
    controller.abort();
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({ upload_id: "upload" });
    await expect(client.uploadPage(page)).resolves.toMatchObject({ upload_id: "upload" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
