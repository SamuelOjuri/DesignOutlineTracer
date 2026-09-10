import { createHash } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { createRoofPlanPdf } from "../fixtures/roofPlan";
import type { Box2D, DetectionRequest, PageContext } from "../../src/types/roi";

type Mode = "complete" | "no_detections" | "partial" | "offline" | "delayed";

async function mockRoi(page: Page) {
  const uploads: { context: PageContext; bytes: Buffer }[] = [];
  const requests: (DetectionRequest & { follow_up_of?: string })[] = [];
  let mode: Mode = "complete";
  let release: (() => void) | undefined;
  await page.route("http://127.0.0.1:4199/api/roi/v1/**", async (route) => {
    const request = route.request();
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, DELETE, OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.url().endsWith("/pages")) {
      const body = await new Response(new Uint8Array(request.postDataBuffer()!), {
        headers: { "content-type": request.headers()["content-type"] },
      }).formData();
      const context = JSON.parse(String(body.get("context"))) as PageContext;
      const bytes = Buffer.from(await (body.get("image") as File).arrayBuffer());
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(context.source_image_hash);
      uploads.push({ context, bytes });
      return route.fulfill({ headers, json: { page: context, upload_id: `upload-${context.page_id}`, expires_in_seconds: 900 } });
    }
    const payload = request.postDataJSON() as DetectionRequest & { follow_up_of?: string };
    requests.push(payload);
    const currentMode = mode;
    const sequence = requests.length;
    if (currentMode === "delayed") await new Promise<void>((resolve) => { release = resolve; });
    if (currentMode === "offline") return route.fulfill({ status: 503, headers, json: { error: { code: "network_error", retryable: true } } });
    const status = currentMode === "delayed" ? "complete" : currentMode;
    const identity: DetectionRequest = { page_id: payload.page_id, request_id: payload.request_id, task: payload.task,
      source_image_hash: payload.source_image_hash, roi_revision: payload.roi_revision, geometry_revision: payload.geometry_revision };
    const boxes: Box2D[] = [[300, 100, 800, 433.3333333333333], [100, 650, 250, 850]];
    const annotations = status === "no_detections" ? [] : boxes.map((box, index) => ({
      id: `roof-${sequence}-${index + 1}`, page_id: payload.page_id, kind: "roof_roi", label: `Synthetic proposed roof ${index + 1}`,
      box_2d: box, proposed_box_2d: box, roi_id: null, origin: "gemini", review_status: "suggested", validity: "current",
      revision: 1, edits: [], warnings: [],
    }));
    const warnings = status === "partial" ? ["Synthetic output limit reached"] : [];
    await route.fulfill({ headers, json: { schema_version: "1", page_id: payload.page_id, request_id: payload.request_id,
      task: "roof_roi", status, roi_revision: null, model: "gemini-3.6-flash", prompt_version: "roof-roi-v1", annotations, warnings,
      run: { ...identity, model: "gemini-3.6-flash", prompt_version: "roof-roi-v1", schema_version: "1", settings: { temperature: 0.5 },
        started_at: "2026-09-09T12:00:00Z", duration_ms: 10, status, warnings, cached: false, provider_attempts: 1 },
    } }).catch((error: Error) => { if (currentMode !== "delayed") throw error; });
  });
  return { uploads, requests, setMode: (value: Mode) => { mode = value; }, release: () => release?.() };
}

async function enterReview(page: Page) {
  await page.goto("/new-build");
  await page.locator('input[type="file"]').setInputFiles(await createRoofPlanPdf());
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Roof Areas", exact: true })).toBeVisible();
}

async function assertAlignment(page: Page, box: Locator) {
  const normalized = JSON.parse((await box.getAttribute("data-box"))!) as Box2D;
  const source = (await page.getByTestId("roi-source-canvas").boundingBox())!;
  const overlay = (await box.boundingBox())!;
  expect(Math.abs(overlay.x - source.x - normalized[1] / 1000 * source.width)).toBeLessThan(1);
  expect(Math.abs(overlay.y - source.y - normalized[0] / 1000 * source.height)).toBeLessThan(1);
  expect(Math.abs(overlay.width - (normalized[3] - normalized[1]) / 1000 * source.width)).toBeLessThan(1);
  expect(Math.abs(overlay.height - (normalized[2] - normalized[0]) / 1000 * source.height)).toBeLessThan(1);
}

async function canvasInk(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let dark = 0;
    let red = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] < 100 && pixels[index + 1] < 100 && pixels[index + 2] < 100) dark++;
      if (pixels[index] > 140 && pixels[index + 1] < 130 && pixels[index + 2] < 130) red++;
    }
    return { dark, red };
  });
}
const continueManually = (page: Page) => page.getByRole("button", { name: "Define roof manually", exact: true });

test("ROI review: independent boxes, source alignment, correction, undo, rerun and passive paint context", async ({ page, networkGuard }, testInfo) => {
  test.setTimeout(120_000);
  const api = await mockRoi(page);
  await enterReview(page);
  expect(api.uploads).toHaveLength(0);
  await page.getByRole("button", { name: "Detect roof areas", exact: true }).click();
  const first = page.getByTestId("annotation-box-roof-1-1");
  await expect(first).toBeVisible();
  await expect(page.getByTestId("annotation-box-roof-1-2")).toBeVisible();
  await assertAlignment(page, first);
  const source = page.getByTestId("roi-source-canvas");
  const pristine = await source.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  expect((await canvasInk(source)).dark).toBeGreaterThan(100);
  expect((await canvasInk(source)).red).toBe(0);
  await page.getByRole("button", { name: "Roof area 1: suggested", exact: true }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  const original = (await first.getAttribute("data-box"))!;
  const bounds = (await first.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 30, bounds.y + bounds.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await expect(first).not.toHaveAttribute("data-box", original);
  const moved = (await first.getAttribute("data-box"))!;
  const handle = (await page.getByRole("button", { name: "Resize Roof area 1 se", exact: true }).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 35, handle.y + 25, { steps: 4 });
  await page.mouse.up();
  await expect(first).not.toHaveAttribute("data-box", moved);
  await page.getByRole("button", { name: "Undo review edit", exact: true }).click();
  await expect(first).toHaveAttribute("data-box", moved);
  await page.getByLabel("Region label").fill("Corrected roof");
  await page.getByLabel("top", { exact: true }).fill("321.125");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await expect(first).toHaveAttribute("data-box", /^\[321\.125,/);
  const corrected = (await first.getAttribute("data-box"))!;
  await page.getByText("Original proposal", { exact: true }).click();
  await expect(page.getByText(`[${JSON.parse(original).join(", ")}]`, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await assertAlignment(page, first);
  await page.getByRole("button", { name: "Pan drawing", exact: true }).click();
  const viewport = page.getByTestId("roi-viewport");
  await viewport.evaluate((element) => { element.scrollLeft = 75; element.scrollTop = 45; });
  await assertAlignment(page, first);
  await expect(first).toHaveAttribute("data-box", corrected);
  expect(await source.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(pristine);
  await page.getByRole("button", { name: "Fit page", exact: true }).click();
  await page.getByRole("button", { name: "Select regions", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("roi-review-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(source).toBeVisible();
  await assertAlignment(page, first);
  expect((await canvasInk(source)).dark).toBeGreaterThan(100);
  await page.screenshot({ path: testInfo.outputPath("roi-review-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Run detection again", exact: true }).click();
  await expect(page.getByTestId("annotation-box-roof-2-1")).toBeVisible();
  await expect(first).toHaveAttribute("data-box", corrected);
  await expect(first).toHaveAttribute("data-status", "accepted");
  expect(api.uploads[0].bytes.equals(api.uploads[1].bytes)).toBe(true);
  await continueManually(page).click();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await expect(first).toHaveAttribute("data-box", corrected);
  const paint = page.locator("canvas").nth(-2);
  expect((await canvasInk(paint)).red).toBe(0);
  const interaction = page.locator("canvas").last();
  const paintSize = (await interaction.boundingBox())!;
  await interaction.click({ position: { x: paintSize.width * 0.25, y: paintSize.height * 0.5 } });
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(first).toHaveAttribute("data-box", corrected);
  await continueManually(page).click();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  expect(networkGuard.submissions).toEqual([]);
});

test("ROI fallback: no detections, bounded partial follow-up, offline retry, rejected-all and manual region", async ({ page, networkGuard }) => {
  test.setTimeout(120_000);
  const api = await mockRoi(page);
  await enterReview(page);
  api.setMode("no_detections");
  await page.getByRole("button", { name: "Detect roof areas", exact: true }).click();
  await expect(page.getByText(/No roof areas returned/)).toBeVisible();
  await expect(continueManually(page)).toBeEnabled();
  api.setMode("partial");
  await page.getByRole("button", { name: "Run detection again", exact: true }).click();
  await expect(page.getByText(/Partial result/)).toBeVisible();
  await page.getByRole("button", { name: "Request one follow-up", exact: true }).click();
  await expect(page.getByRole("button", { name: "Request one follow-up", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Run detection again", exact: true })).toBeVisible();
  expect(api.requests[2].follow_up_of).toBe(api.requests[1].request_id);
  api.setMode("offline");
  networkGuard.expectedConsoleErrors.push("Failed to load resource: the server responded with a status of 503 (Service Unavailable)");
  await page.getByRole("button", { name: "Run detection again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("service is unavailable");
  await expect(continueManually(page)).toBeEnabled();
  api.setMode("complete");
  await page.getByRole("button", { name: "Retry detection", exact: true }).click();
  await expect(page.getByTestId("annotation-box-roof-5-1")).toBeVisible();
  const suggested = page.getByRole("list", { name: "Regions", exact: true }).getByRole("button").filter({ hasText: "suggested / Gemini" });
  while (await suggested.count()) {
    await suggested.first().click();
    await page.getByRole("button", { name: "Reject", exact: true }).click();
  }
  await expect(continueManually(page)).toBeEnabled();
  await continueManually(page).click();
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("button", { name: "Manual region", exact: true }).click();
  const source = (await page.getByTestId("roi-source-canvas").boundingBox())!;
  await page.mouse.move(source.x + source.width * 0.1, source.y + source.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width * 0.4, source.y + source.height * 0.7, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByText("accepted / Manual", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Delete region", exact: true }).click();
  await expect(page.getByText("accepted / Manual", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo review edit", exact: true }).click();
  await expect(page.getByText("accepted / Manual", { exact: true })).toBeVisible();
});

test("ROI requests: cancel and page switch discard delayed results", async ({ page }) => {
  test.setTimeout(120_000);
  const api = await mockRoi(page);
  await enterReview(page);
  api.setMode("delayed");
  await page.getByRole("button", { name: "Detect roof areas", exact: true }).click();
  await expect.poll(() => api.requests.length).toBe(1);
  await page.getByRole("button", { name: "Cancel detection", exact: true }).click();
  api.release();
  await expect(page.getByText(/Detection cancelled/)).toBeVisible();
  await page.getByRole("button", { name: "Detect roof areas", exact: true }).click();
  await expect.poll(() => api.requests.length).toBe(2);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(await createRoofPlanPdf());
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "\u2192", exact: true }).click();
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  api.release();
  await expect(page.getByTestId("annotation-overlay").locator("[data-box]")).toHaveCount(0);
  api.setMode("complete");
  await page.getByRole("button", { name: "Detect roof areas", exact: true }).click();
  await expect(page.getByTestId("annotation-box-roof-3-1")).toBeVisible();
  expect(api.requests[2].page_id).not.toBe(api.requests[1].page_id);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(await createRoofPlanPdf());
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByTestId("annotation-overlay").locator("[data-box]")).toHaveCount(0);
});