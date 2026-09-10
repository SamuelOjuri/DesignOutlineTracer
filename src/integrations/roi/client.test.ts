import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetectionRequest } from "@/types/roi";
import { syntheticAnnotation, syntheticPage, syntheticRun } from "@/test/roi";
import { createRoiClient } from "./client";

const page = { ...syntheticPage(), source_image_hash: "a".repeat(64) };
const request: DetectionRequest = { page_id: page.page_id, request_id: "request", task: "roof_roi",
  source_image_hash: page.source_image_hash, roi_revision: null, geometry_revision: 0 };

function responseEnvelope(identity = request) {
  const run = { ...syntheticRun(identity), model: "gemini-3.6-flash", prompt_version: "roof-roi-v1", cached: false, provider_attempts: 1 };
  return { schema_version: "1", page_id: identity.page_id, request_id: identity.request_id, task: identity.task,
    roi_revision: identity.roi_revision, model: run.model, prompt_version: run.prompt_version, status: run.status,
    annotations: [syntheticAnnotation("annotation", { origin: "gemini", review_status: "suggested" })], warnings: [], run };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function setup(fetcher = vi.fn<typeof fetch>()) {
  return { fetcher, client: createRoiClient({ enabled: true, baseUrl: "http://127.0.0.1:8091", fetch: fetcher }) };
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("isolated ROI client", () => {
  it("makes zero requests with the feature flag disabled, including invalid inputs", async () => {
    vi.stubEnv("VITE_ROI_ENABLED", "false");
    const fetcher = vi.fn<typeof fetch>();
    const client = createRoiClient({ fetch: fetcher });
    expect(client.enabled).toBe(false);
    for (const operation of [() => client.health(), () => client.uploadPage(page), () => client.detect(request), () => client.deletePage("bad/id")]) {
      await expect(operation()).rejects.toMatchObject({ code: "feature_disabled" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uploads only the immutable source and verifies server identity", async () => {
    const { fetcher, client } = setup();
    const { source_blob, ...context } = page;
    fetcher.mockResolvedValueOnce(jsonResponse({ page: context, upload_id: "upload_1", expires_in_seconds: 900 }));
    await client.uploadPage(page);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8091/api/roi/v1/pages");
    const form = init.body as FormData;
    expect(JSON.parse(form.get("context") as string)).toEqual(context);
    expect(form.get("image")).toBeInstanceOf(Blob);
    expect((form.get("image") as Blob).size).toBe(source_blob.size);
    expect(init).toMatchObject({ credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" });
    expect((init.headers as Record<string, string>).Authorization).toMatch(/^Bearer [a-f0-9]{64}$/);
    expect(init.headers).not.toHaveProperty("Content-Type");
    fetcher.mockResolvedValueOnce(jsonResponse({ page: { ...context, source_width: 1 }, upload_id: "upload_1", expires_in_seconds: 900 }));
    await expect(client.uploadPage(page)).rejects.toMatchObject({ code: "response_identity_mismatch" });
  });

  it("returns suggestions with Phase 2 request identity and reuses only its in-memory token", async () => {
    const { fetcher, client } = setup();
    fetcher.mockImplementation(async () => jsonResponse(responseEnvelope()));
    const result = await client.detect(request);
    expect(result.run).toMatchObject(request);
    expect(result.annotations[0]).toMatchObject({ review_status: "suggested", roi_id: null });
    await client.detect(request);
    expect(fetcher.mock.calls[0][1].headers).toEqual(fetcher.mock.calls[1][1].headers);
    const other = createRoiClient({ enabled: true, baseUrl: "http://127.0.0.1:8091", fetch: fetcher });
    await other.detect(request);
    expect(fetcher.mock.calls[2][1].headers).not.toEqual(fetcher.mock.calls[0][1].headers);
  });

  it("keeps the dispatched identity even if the caller mutates its request", async () => {
    const { fetcher, client } = setup();
    const mutableRequest = { ...request };
    fetcher.mockImplementation(async () => {
      mutableRequest.page_id = "changed-after-dispatch";
      mutableRequest.geometry_revision = 99;
      return jsonResponse(responseEnvelope());
    });
    expect((await client.detect(mutableRequest)).run).toMatchObject(request);
  });

  it.each(["page_id", "request_id", "source_image_hash", "roi_revision", "geometry_revision"])("rejects mismatched run %s", async (field) => {
    const { fetcher, client } = setup();
    const envelope = responseEnvelope();
    fetcher.mockResolvedValue(jsonResponse({ ...envelope, run: { ...envelope.run,
      [field]: field.endsWith("revision") ? 1 : field === "source_image_hash" ? "b".repeat(64) : "other" } }));
    await expect(client.detect(request)).rejects.toMatchObject({ code: "response_identity_mismatch" });
  });

  it("requires accepted current same-page parents and snapshots fractional boxes", async () => {
    const { fetcher, client } = setup();
    const childRequest = { ...request, task: "penetration" as const, roi_revision: 1 };
    await expect(client.detect(childRequest)).rejects.toMatchObject({ code: "invalid_parents" });
    for (const patch of [{ validity: "needs_review" as const }, { review_status: "rejected" as const }, { page_id: "other" }]) {
      await expect(client.detect(childRequest, { acceptedRois: [syntheticAnnotation("roof", patch)] })).rejects.toMatchObject({ code: "invalid_parents" });
    }
    expect(fetcher).not.toHaveBeenCalled();
    const parent = syntheticAnnotation("roof", { box_2d: [0.5, 1.5, 600, 700] });
    const envelope = responseEnvelope(childRequest);
    envelope.annotations = [syntheticAnnotation("vent", { kind: "penetration", subtype: "vent", roi_id: "roof", origin: "gemini", review_status: "suggested" })];
    fetcher.mockResolvedValueOnce(jsonResponse(envelope));
    await client.detect(childRequest, { acceptedRois: [parent] });
    expect(JSON.parse(fetcher.mock.calls[0][1].body as string).accepted_rois).toEqual([{ id: "roof", revision: 1, box_2d: parent.box_2d }]);
    envelope.annotations[0].roi_id = "unknown";
    fetcher.mockResolvedValueOnce(jsonResponse(envelope));
    await expect(client.detect(childRequest, { acceptedRois: [parent] })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("distinguishes valid empty, partial, and structured errors without retrying", async () => {
    const { fetcher, client } = setup();
    const envelope = responseEnvelope();
    fetcher.mockResolvedValueOnce(jsonResponse({ ...envelope, status: "no_detections", annotations: [], run: { ...envelope.run, status: "no_detections" } }));
    expect((await client.detect(request)).status).toBe("no_detections");
    fetcher.mockResolvedValueOnce(jsonResponse({ ...envelope, status: "partial", warnings: ["possible_truncation"], run: { ...envelope.run, status: "partial" } }));
    expect((await client.detect(request, { followUpOf: "prior" })).status).toBe("partial");
    expect(JSON.parse(fetcher.mock.calls[1][1].body as string).follow_up_of).toBe("prior");
    fetcher.mockResolvedValueOnce(jsonResponse({ error: { code: "provider_refusal", retryable: false } }, 502));
    await expect(client.detect(request)).rejects.toMatchObject({ code: "provider_refusal", status: 502, retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed geometry, accepted responses, wrong models, and oversized responses", async () => {
    const { fetcher, client } = setup();
    const envelope = responseEnvelope();
    for (const annotation of [{ ...envelope.annotations[0], box_2d: [1, 2, 0, 3] },
      { ...envelope.annotations[0], review_status: "accepted" }]) {
      fetcher.mockResolvedValueOnce(jsonResponse({ ...envelope, annotations: [annotation] }));
      await expect(client.detect(request)).rejects.toMatchObject({ code: "invalid_contract" });
    }
    fetcher.mockResolvedValueOnce(jsonResponse({ ...envelope, model: "another-model" }));
    await expect(client.detect(request)).rejects.toMatchObject({ code: "invalid_contract" });
    fetcher.mockResolvedValueOnce(new Response("x".repeat(1024 * 1024 + 1)));
    await expect(client.detect(request)).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("cancels an in-flight request and never starts a pre-aborted request", async () => {
    const { fetcher, client } = setup();
    fetcher.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const controller = new AbortController();
    const pending = client.detect(request, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await expect(client.detect(request, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out, deletes explicitly, and rejects remote configuration", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const client = createRoiClient({ enabled: true, baseUrl: "http://localhost:8091", fetch: fetcher, timeoutMs: 10 });
    const pending = expect(client.detect(request)).rejects.toMatchObject({ code: "request_timeout" });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await client.deletePage("page-1");
    expect(fetcher.mock.lastCall[1].method).toBe("DELETE");
    const remote = createRoiClient({ enabled: true, baseUrl: "https://unreviewed.example", fetch: fetcher });
    await expect(remote.health()).rejects.toMatchObject({ code: "invalid_configuration" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});