import { createHash } from "node:crypto";
import { test, expect } from "./fixtures";
import { createPenetrationPlanPdf } from "../fixtures/roofPlan";
import type { OutlineRequest, OutlineResponse } from "../../src/types/outline";
import type { PageContext } from "../../src/types/roi";

test("generates a reviewable stepped outline, applies without filling its notch, and undoes atomically", async ({ page }, testInfo) => {
  const requests: OutlineRequest[] = [];
  const uploads: Buffer[] = [];
  let context: PageContext | undefined;
  const points = [{ x: 60, y: 320 }, { x: 140, y: 320 }, { x: 140, y: 200 },
    { x: 260, y: 200 }, { x: 260, y: 120 }, { x: 60, y: 120 }];
  await page.route("http://127.0.0.1:4199/api/roi/v1/**", async route => {
    const request = route.request();
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.url().endsWith("/pages")) {
      const body = await new Response(new Uint8Array(request.postDataBuffer()!), {
        headers: { "content-type": request.headers()["content-type"] },
      }).formData();
      context = JSON.parse(String(body.get("context"))) as PageContext;
      const bytes = Buffer.from(await (body.get("image") as File).arrayBuffer());
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(context.source_image_hash);
      uploads.push(bytes);
      return route.fulfill({ headers, json: { page: context, upload_id: "outline-upload", expires_in_seconds: 900 } });
    }
    expect(request.url()).toMatch(/\/outlines$/);
    const payload = request.postDataJSON() as OutlineRequest;
    requests.push(payload);
    const response: OutlineResponse = {
      schema_version: "outline-1", page_id: payload.page_id, request_id: payload.request_id,
      source_image_hash: payload.source_image_hash, roi_revision: payload.roi_revision,
      geometry_revision: payload.geometry_revision, roi_id: payload.roi.id, roi_annotation_revision: payload.roi.revision,
      boundary_policy: payload.boundary_policy, status: "needs_review",
      proposals: [{ id: `outline-${requests.length}`, points, proposed_points: points, warnings: [],
        edges: points.map((_, index) => ({ index, support: index === 2 ? 0.3 : 1, source: "vector", ambiguous: index === 2 })) }],
      warnings: ["ambiguous_edges"],
      crop: { x: 20, y: 70, width: 300, height: 290, inference_width: 300, inference_height: 290 },
      run: { model: "gemini-4-argon", prompt_version: "roof-outline-v1", algorithm_version: "synthetic-fit",
        settings: {}, duration_ms: 10, cached: false, provider_attempts: 1 },
    };
    return route.fulfill({ headers, json: response });
  });
  await page.goto("/new-build");
  await page.locator('input[type="file"]').setInputFiles(await createPenetrationPlanPdf());
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Manual region", exact: true }).click();
  const bounds = (await page.getByTestId("roi-source-canvas").boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.08, bounds.y + bounds.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.85);
  await page.mouse.up();
  await page.getByRole("button", { name: "Set Outlines", exact: true }).click();
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeDisabled();
  expect(requests).toHaveLength(0);
  await page.getByLabel("Boundary to follow", { exact: true }).selectOption("inner_parapet");
  await page.getByRole("button", { name: "Generate outline", exact: true }).click();
  const overlay = page.getByTestId("outline-proposal-overlay");
  await expect(overlay).toBeVisible();
  await expect(next).toBeDisabled();
  expect(requests).toHaveLength(1);
  expect(requests[0].vector_segments.length).toBeGreaterThan(0);
  expect(requests[0].source_image_hash).toBe(context!.source_image_hash);
  await expect(overlay.locator('[data-uncertain="true"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const sourceBounds = (await page.getByTestId("paint-source-canvas").boundingBox())!;
  const overlayBounds = (await overlay.boundingBox())!;
  for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(sourceBounds[key] - overlayBounds[key])).toBeLessThan(1);
  await testInfo.attach("outline-proposal", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Use outline", exact: true }).click();
  await expect(overlay).toHaveCount(0);
  await expect(next).toBeEnabled();
  await expect(page.getByRole("button", { name: "Adjust", exact: true })).toBeEnabled();
  const selection = await page.getByTestId("paint-source-canvas").evaluate((element: HTMLCanvasElement) => {
    const context = element.getContext("2d")!;
    const red = (x: number, y: number) => {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      // The editor deliberately composites a translucent tint over the source.
      return r > 180 && r - g > 20 && r - b > 20;
    };
    return { inside: red(80, 250), notch: red(200, 270) };
  });
  expect(selection).toEqual({ inside: true, notch: false });
  await page.getByRole("button", { name: "Undo generated outline", exact: true }).click();
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "Generate outline", exact: true }).click();
  await expect(overlay).toBeVisible();
  expect(uploads).toHaveLength(2);
  expect(uploads[1]).toEqual(uploads[0]);
  await page.getByLabel("Boundary to follow", { exact: true }).selectOption("roof_deck");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use outline", exact: true })).toHaveCount(0);
});
