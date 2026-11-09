import { describe, expect, it, vi } from "vitest";
import { syntheticAnnotation, syntheticPage, syntheticRun } from "@/test/roi";
import type { DetectionRequest } from "@/types/roi";
import { createRoiClient } from "./client";

const source = syntheticPage();
const size = { width: source.source_width, height: source.source_height };
const request: DetectionRequest = { page_id: source.page_id, request_id: "scan", task: "penetration",
  source_image_hash: "a".repeat(64), roi_revision: 1, geometry_revision: 1 };
const parent = syntheticAnnotation("parent", { box_2d: [0, 0, 1000, 1000] });
const footprint = [{ x: 200, y: 200 }, { x: 280, y: 200 }, { x: 280, y: 240 },
  { x: 240, y: 240 }, { x: 240, y: 280 }, { x: 200, y: 280 }];
const scope = { roi_id: "parent", outline_id: "scope", outer: [{ x: 40, y: 40 }, { x: 740, y: 40 },
  { x: 740, y: 500 }, { x: 40, y: 500 }], holes: [] };
function envelope() {
  return { schema_version: "1", page_id: request.page_id, request_id: request.request_id, task: request.task,
    roi_revision: 1, model: "gemini-4-argon", prompt_version: "penetration-v2", status: "complete", warnings: [],
    annotations: [syntheticAnnotation("riser", { origin: "gemini", kind: "penetration", subtype: "riser", roi_id: "parent",
      outline_id: "scope", footprint, proposed_footprint: footprint.map(p => ({ x: p.x + 1, y: p.y })), footprint_source: "vector",
      review_status: "suggested", box_2d: [300, 200, 500, 400] })],
    run: { ...syntheticRun(request), model: "gemini-4-argon", prompt_version: "penetration-v2", cached: false, provider_attempts: 16 } };
}
const setup = (response = envelope()) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
  return { fetcher, client: createRoiClient({ enabled: true, baseUrl: "http://127.0.0.1:8091", fetch: fetcher }) };
};

describe("polygon penetration transport", () => {
  it("sends actual scope/vectors and preserves fitted and original source-pixel polygons across bounded detail scans", async () => {
    const response = envelope(), { client, fetcher } = setup(response);
    const result = await client.detect(request, { acceptedRois: [parent], scopes: [scope], sourceSize: size,
      vectorSegments: [{ start: footprint[0], end: footprint[1] }] });
    const payload = JSON.parse(fetcher.mock.calls[0][1].body as string);
    expect(payload.scopes).toEqual([scope]);
    expect(payload.vector_segments).toHaveLength(1);
    expect(result.annotations[0]).toMatchObject({ footprint, proposed_footprint: response.annotations[0].proposed_footprint,
      footprint_source: "vector", outline_id: "scope" });
    result.annotations[0].footprint![0].x = 999;
    expect(response.annotations[0].footprint![0].x).toBe(200);
    expect(result.run.provider_attempts).toBe(16);
  });

  it("continues accepting legacy box-only penetration responses with null geometry additions", async () => {
    const response = envelope();
    Object.assign(response.annotations[0], { footprint: null, proposed_footprint: null, footprint_source: null, outline_id: null });
    const { client } = setup(response);
    expect((await client.detect(request, { acceptedRois: [parent], sourceSize: size })).annotations[0].footprint).toBeUndefined();
  });

  it("rejects invalid and out-of-page polygon responses before session state", async () => {
    for (const invalid of [
      [{ x: 200, y: 200 }, { x: 300, y: 300 }, { x: 200, y: 300 }, { x: 300, y: 200 }],
      footprint.map(p => ({ x: p.x + 700, y: p.y })),
    ]) {
      const response = envelope();
      response.annotations[0].footprint = invalid;
      const { client } = setup(response);
      await expect(client.detect(request, { acceptedRois: [parent], scopes: [scope], sourceSize: size })).rejects.toMatchObject({
        code: invalid[0].x > size.width ? "invalid_response" : "invalid_contract",
      });
    }
  });

  it("rejects unassigned scope geometry without networking", async () => {
    const { client, fetcher } = setup();
    await expect(client.detect(request, { acceptedRois: [parent], scopes: [{ ...scope, roi_id: "other" }] })).rejects.toMatchObject({ code: "invalid_contract" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
