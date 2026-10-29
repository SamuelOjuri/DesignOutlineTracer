import { createHash } from "node:crypto";
import { test, expect } from "./fixtures";
import { createPenetrationPlanPdf } from "../fixtures/roofPlan";
import type { OutlineRequest, OutlineResponse } from "../../src/types/outline";
import type { OutletRequest, OutletResponse } from "../../src/types/outlet";
import type { Box2D, PageContext } from "../../src/types/roi";

test("detects, reviews and preserves outlet anchors with contained and boundary-overlapping blue markers", async ({ page }, testInfo) => {
  const requests: OutletRequest[] = [];
  const uploads: Buffer[] = [];
  let context: PageContext;
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
      return route.fulfill({ headers, json: { page: context, upload_id: "outlet-upload", expires_in_seconds: 900 } });
    }
    if (request.url().endsWith("/outlines")) {
      const payload = request.postDataJSON() as OutlineRequest;
      const response: OutlineResponse = {
        schema_version: "outline-1", page_id: payload.page_id, request_id: payload.request_id,
        source_image_hash: payload.source_image_hash, roi_revision: payload.roi_revision, geometry_revision: payload.geometry_revision,
        roi_id: payload.roi.id, roi_annotation_revision: payload.roi.revision, boundary_policy: payload.boundary_policy,
        status: "complete", proposals: [{ id: "scope", points, proposed_points: points, warnings: [],
          edges: points.map((_, index) => ({ index, support: 1, source: "vector", ambiguous: false })) }], warnings: [],
        crop: { x: 20, y: 70, width: 300, height: 290, inference_width: 300, inference_height: 290 },
        run: { model: "synthetic", prompt_version: "roof-outline-v1", algorithm_version: "synthetic",
          settings: {}, duration_ms: 1, cached: false, provider_attempts: 1 },
      };
      return route.fulfill({ headers, json: response });
    }
    expect(request.url()).toMatch(/\/outlets$/);
    const payload = request.postDataJSON() as OutletRequest;
    requests.push(payload);
    const scope = payload.scopes[0];
    const response: OutletResponse = {
      contract_version: "outlet-1", page_id: payload.page_id, request_id: payload.request_id,
      source_image_hash: payload.source_image_hash, scope_signature: payload.scope_signature,
      status: "complete", model: "synthetic", prompt_version: "rainwater-outlet-v1", warnings: [],
      annotations: [{ x: 90, y: 150, label: "Interior inlet" }, { x: 60, y: 220, label: "Boundary inlet" },
        { x: 200, y: 270, label: "Outside notch" }].map((point, index) => {
        const box: Box2D = [(point.y - 3) / context.source_height * 1000, (point.x - 3) / context.source_width * 1000,
          (point.y + 3) / context.source_height * 1000, (point.x + 3) / context.source_width * 1000];
        return { id: `inlet-${requests.length}-${index}`, page_id: payload.page_id, kind: "rainwater_outlet",
          label: point.label, subtype: index === 1 ? "parapet_outlet" : "internal_outlet",
          box_2d: box, proposed_box_2d: box, anchor: { x: point.x, y: point.y }, proposed_anchor: { x: point.x, y: point.y },
          roi_id: scope.roi_id, outline_id: scope.outline_id, origin: "gemini", review_status: "suggested",
          validity: index === 2 ? "needs_review" : "current", revision: 1, edits: [],
          warnings: index === 2 ? ["outlet_outside_scope"] : [], evidence: "Synthetic source inlet symbol", };
      }),
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
  await page.getByRole("button", { name: "Generate outline", exact: true }).click();
  await page.getByRole("button", { name: "Use outline", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Penetrations", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Detect outlets", exact: true })).toBeEnabled();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Detect outlets", exact: true }).click();
  await expect(page.getByRole("button", { name: "Accept eligible (2)", exact: true })).toBeVisible();
  expect(requests[0].scopes[0].polygons[0].outer).toHaveLength(6);
  await page.getByRole("button", { name: "Accept eligible (2)", exact: true }).click();
  await expect(page.getByText("2 accepted / 3 reviewed or suggested", { exact: true })).toBeVisible();
  const canvas = page.getByLabel("Roof outlet placement", { exact: true });
  const ink = () => canvas.evaluate((element: HTMLCanvasElement) => {
    const ctx = element.getContext("2d")!;
    const scale = element.getBoundingClientRect().width / element.width;
    const dimensions = (x: number, y: number) => {
      const found: number[] = [];
      const pixels = ctx.getImageData(x - 20, y - 20, 40, 40).data;
      for (let py = 0; py < 40; py++) for (let px = 0; px < 40; px++) {
        const i = (py * 40 + px) * 4;
        const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
        // Subpixel antialiasing blends a thin blue stroke with its white halo.
        if (r < 180 && g > r + 20 && b > g + 25 && b > 150) found.push(x - 20 + px);
      }
      return { left: Math.min(...found), right: Math.max(...found), screenWidth: (Math.max(...found) - Math.min(...found) + 1) * scale };
    };
    return { interior: dimensions(90, 150), boundary: dimensions(60, 220) };
  });
  const before = await ink();
  expect(before.boundary.left).toBeLessThan(60);
  expect(before.boundary.right).toBeGreaterThan(60);
  expect(before.interior.left).toBeGreaterThan(60);
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const after = await ink();
  expect(Math.abs(before.interior.screenWidth - after.interior.screenWidth)).toBeLessThan(3);
  await page.getByRole("button", { name: /Outside notch/ }).click();
  await expect(page.getByRole("button", { name: "Accept outlet", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await page.getByRole("button", { name: /Interior inlet.*accepted/ }).click();
  await page.getByText("Correct position, type or size", { exact: true }).click();
  await page.getByLabel("Outlet X position", { exact: true }).fill("95");
  await page.getByRole("button", { name: "Apply position", exact: true }).click();
  await page.getByRole("button", { name: "Detect outlets", exact: true }).click();
  await expect(page.getByText("Outlet suggestions are ready for review.", { exact: true })).toBeVisible();
  await expect(page.getByRole("group", { name: "Outlet recommendations", exact: true }).getByRole("button")).toHaveCount(3);
  await page.getByText("Correct position, type or size", { exact: true }).click();
  await expect(page.getByLabel("Outlet X position", { exact: true })).toHaveValue("95");
  expect(uploads.every(upload => upload.equals(uploads[0]))).toBe(true);
  await testInfo.attach("outlet-review", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByLabel("Outlet review summary")).toContainText("2 accepted detections");
  await expect(page.getByLabel("Outlet review summary")).toContainText("unconfirmed application default");
});
