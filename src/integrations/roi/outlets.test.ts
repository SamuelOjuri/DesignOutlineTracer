import { describe, expect, it, vi } from "vitest";
import { outletRequest, outletResponse } from "@/test/outlet";
import { createRoiClient } from "./client";
import { outletRequestSchema, validateOutletResponse } from "./outlets";

describe("outlet contract", () => {
  it("keeps symbol geometry separate from the precise inlet anchor", () => {
    const request = outletRequest();
    const result = validateOutletResponse(request, outletResponse(request));
    expect(result.annotations[0].anchor).toEqual({ x: 225, y: 120 });
    expect(result.annotations[0].box_2d).toEqual([190, 270, 210, 290]);
    expect(outletRequestSchema.safeParse(request).success).toBe(true);
  });

  it("rejects foreign parents, duplicate scopes and oversized geometry before networking", () => {
    const request = outletRequest();
    expect(outletRequestSchema.safeParse({ ...request, scopes: [{ ...request.scopes[0], roi_id: "another-roof" }] }).success).toBe(false);
    expect(outletRequestSchema.safeParse({ ...request, scopes: [...request.scopes, request.scopes[0]] }).success).toBe(false);
    expect(outletRequestSchema.safeParse({ ...request, scopes: [{ ...request.scopes[0], polygons: [{ holes: [],
      outer: Array.from({ length: 513 }, (_, index) => ({ x: index, y: index })) }] }] }).success).toBe(false);
  });

  it.each(["page_id", "request_id", "source_image_hash", "scope_signature"] as const)("rejects a response with different %s", field => {
    const request = outletRequest();
    expect(() => validateOutletResponse(request, { ...outletResponse(request), [field]: field === "source_image_hash" ? "b".repeat(64) : "different" }))
      .toThrow(/response_identity_mismatch/);
  });

  it("rejects duplicate identities, wrong outline ownership and fabricated original positions", () => {
    const request = outletRequest(), response = outletResponse(request);
    for (const annotations of [
      [...response.annotations, response.annotations[0]],
      [{ ...response.annotations[0], outline_id: "foreign-outline" }],
      [{ ...response.annotations[0], proposed_anchor: { x: 999, y: 999 } }],
    ]) expect(() => validateOutletResponse(request, { ...response, annotations })).toThrow(/invalid_response/);
    expect(() => validateOutletResponse(request, { ...response, status: "no_detections" })).toThrow(/invalid_response/);
  });

  it("shares the existing authenticated client transport and validates source ownership", async () => {
    const request = outletRequest();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(outletResponse(request)),
      { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createRoiClient({ enabled: true, baseUrl: "http://127.0.0.1:8091", fetch: fetcher });
    await expect(client.generateOutlets(request)).resolves.toMatchObject({ scope_signature: request.scope_signature });
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:8091/api/roi/v1/pages/page-1/outlets");
    expect(JSON.parse(fetcher.mock.calls[0][1]!.body as string).scopes).toEqual(request.scopes);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: "omit", redirect: "error", cache: "no-store" });
    const disabled = createRoiClient({ enabled: false, fetch: fetcher });
    await expect(disabled.generateOutlets(request)).rejects.toMatchObject({ code: "feature_disabled" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
