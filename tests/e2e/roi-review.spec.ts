import { createHash } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { createOpenRoofPlanPdf, createPenetrationPlanPdf, createRoofPlanPdf } from "../fixtures/roofPlan";
import type { Box2D, DetectionRequest, PageContext } from "../../src/types/roi";

type Mode = "complete" | "no_detections" | "partial" | "offline" | "delayed";
type Payload = DetectionRequest & { follow_up_of?: string; accepted_rois: { id: string; revision: number; box_2d: Box2D }[] };

async function mockRoi(page: Page) {
  const uploads: { context: PageContext; bytes: Buffer }[] = [];
  const requests: Payload[] = [];
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
    const payload = request.postDataJSON() as Payload;
    requests.push(payload);
    const currentMode = mode;
    const sequence = requests.length;
    if (currentMode === "delayed") await new Promise<void>((resolve) => { release = resolve; });
    if (currentMode === "offline") return route.fulfill({ status: 503, headers, json: { error: { code: "network_error", retryable: true } } });
    const status = currentMode === "delayed" ? "complete" : currentMode;
    const identity: DetectionRequest = { page_id: payload.page_id, request_id: payload.request_id, task: payload.task,
      source_image_hash: payload.source_image_hash, roi_revision: payload.roi_revision, geometry_revision: payload.geometry_revision };
    const childTask = payload.task === "penetration";
    const promptVersion = childTask ? "penetration-v1" : "roof-roi-v1";
    const boxes: Box2D[] = childTask ? [[400, 180, 450, 220], [150, 700, 180, 740], [850, 500, 900, 550], [650, 350, 690, 380]]
      : [[300, 100, 800, 433.3333333333333], [100, 650, 250, 850]];
    const annotations = status === "no_detections" ? [] : boxes.map((box, index) => ({
      id: `${childTask ? "child" : "roof"}-${sequence}-${index + 1}`, page_id: payload.page_id, kind: payload.task,
      label: `Synthetic ${childTask ? "penetration" : "proposed roof"} ${index + 1}`,
      ...(childTask ? { subtype: index === 0 ? "rooflight" : "vent" } : {}),
      box_2d: box, proposed_box_2d: box, roi_id: childTask ? (payload.accepted_rois[index === 1 ? 1 : 0] ?? payload.accepted_rois[0]).id : null,
      origin: "gemini", review_status: "suggested", validity: "current",
      revision: 1, edits: [], warnings: [],
    }));
    const warnings = status === "partial" ? ["Synthetic output limit reached"] : [];
    await route.fulfill({ headers, json: { schema_version: "1", page_id: payload.page_id, request_id: payload.request_id,
      task: payload.task, status, roi_revision: payload.roi_revision, model: "gemini-3.6-flash", prompt_version: promptVersion, annotations, warnings,
      run: { ...identity, model: "gemini-3.6-flash", prompt_version: promptVersion, schema_version: "1", settings: { temperature: 0.5 },
        started_at: "2026-09-09T12:00:00Z", duration_ms: 10, status, warnings, cached: false, provider_attempts: 1 },
    } }).catch((error: Error) => { if (currentMode !== "delayed") throw error; });
  });
  return { uploads, requests, setMode: (value: Mode) => { mode = value; }, release: () => release?.() };
}

async function enterReview(page: Page, fixture = createRoofPlanPdf) {
  await page.goto("/new-build");
  await page.locator('input[type="file"]').setInputFiles(await fixture());
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

test("ROI bounds constrain hover, click, drag and saved polygons on an open roof", async ({ page }) => {
  await enterReview(page, createOpenRoofPlanPdf);
  await page.getByRole("button", { name: "Manual region", exact: true }).click();
  const source = (await page.getByTestId("roi-source-canvas").boundingBox())!;
  await page.mouse.move(source.x + source.width * 0.2, source.y + source.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width * 0.8, source.y + source.height * 0.8);
  await page.mouse.up();
  const box = JSON.parse((await page.locator('[data-testid^="annotation-box-"]').getAttribute("data-box"))!) as Box2D;
  await continueManually(page).click();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  const preview = page.getByTestId("paint-interaction-canvas");
  const next = page.getByRole("button", { name: "Next", exact: true });
  const move = async (x: number, y: number) => {
    const bounds = (await preview.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width * x, bounds.y + bounds.height * y);
  };
  const previewPixels = () => preview.evaluate((canvas: HTMLCanvasElement, roi) => {
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let inside = 0, outside = 0;
    for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
      const i = (y * canvas.width + x) * 4;
      // Canvas premultiplication can round translucent RGB channels by one or two levels.
      if (Math.abs(pixels[i] - 50) > 2 || Math.abs(pixels[i + 1] - 130) > 2
        || Math.abs(pixels[i + 2] - 220) > 2 || pixels[i + 3] !== 100) continue;
      if (x >= roi[1] / 1000 * canvas.width && x + 1 <= roi[3] / 1000 * canvas.width
        && y >= roi[0] / 1000 * canvas.height && y + 1 <= roi[2] / 1000 * canvas.height) inside++;
      else outside++;
    }
    return { inside, outside };
  }, box);
  await move(0.35, 0.4);
  await expect.poll(async () => (await previewPixels()).inside).toBeGreaterThan(500);
  expect((await previewPixels()).outside).toBe(0);
  await page.mouse.down();
  await page.mouse.up();
  await expect(next).toBeEnabled();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(next).toBeDisabled();
  await move(0.1, 0.1);
  await page.mouse.down();
  await page.mouse.up();
  await expect(page.getByRole("status")).toHaveText("Click inside a green roof region to select an area.");
  await expect(next).toBeDisabled();
  await page.getByTitle("Zoom in", { exact: true }).click();
  await move(0.35, 0.4);
  await expect.poll(async () => (await previewPixels()).inside).toBeGreaterThan(500);
  expect((await previewPixels()).outside).toBe(0);
  await page.mouse.down();
  await move(0.9, 0.9);
  expect((await previewPixels()).outside).toBe(0);
  await page.mouse.up();
  await expect(next).toBeEnabled();
  await next.click();
  const geometry = page.getByLabel("Manual roof geometry").locator("polygon");
  const polygons = await geometry.evaluateAll(elements => elements.map(element => element.getAttribute("points")!));
  expect(polygons.length).toBeGreaterThan(0);
  for (const polygon of polygons) for (const point of polygon.split(" ")) {
    const [x, y] = point.split(",").map(Number);
    expect(x).toBeGreaterThanOrEqual(box[1] / 1000 * 600);
    expect(x).toBeLessThanOrEqual(box[3] / 1000 * 600);
    expect(y).toBeGreaterThanOrEqual(box[0] / 1000 * 400);
    expect(y).toBeLessThanOrEqual(box[2] / 1000 * 400);
  }
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  await expect(next).toBeEnabled();
  await move(0.1, 0.1);
  await expect.poll(async () => (await previewPixels()).outside).toBe(0);
});

async function enterPenetrations(page: Page, withParents = true) {
  await enterReview(page, createPenetrationPlanPdf);
  if (withParents) {
    await page.getByRole("button", { name: "Detect roof areas", exact: true }).click();
    for (const index of [1, 2]) {
      await page.getByRole("button", { name: `Roof area ${index}: suggested`, exact: true }).click();
      await page.getByRole("button", { name: "Accept", exact: true }).click();
    }
  }
  await continueManually(page).click();
  const canvas = page.locator("canvas").last();
  const bounds = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: bounds.width * 0.15, y: bounds.height * 0.6 } });
  await canvas.click({ position: { x: bounds.width * 0.8, y: bounds.height * 0.15 } });
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Penetrations", exact: true })).toBeVisible();
}

test("Penetrations: conditioned boxes, nonrectangular exclusions, corrections, reruns and summary", async ({ page, networkGuard }, testInfo) => {
  test.setTimeout(120_000);
  const api = await mockRoi(page);
  await enterPenetrations(page);
  const source = page.getByTestId("roi-source-canvas");
  const pristine = await source.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  await page.getByRole("button", { name: "Detect penetrations", exact: true }).click();
  const first = page.getByTestId("annotation-box-child-2-1");
  await expect(first).toBeVisible();
  expect(api.requests[1].task).toBe("penetration");
  expect(api.requests[1].accepted_rois.map((parent) => parent.id)).toEqual(["roof-1-1", "roof-1-2"]);
  expect(api.requests[1].roi_revision).toBeGreaterThan(0);
  expect(api.requests[1].geometry_revision).toBeGreaterThan(0);
  expect(api.uploads[0].bytes.equals(api.uploads[1].bytes)).toBe(true);
  const list = page.getByRole("list", { name: "Penetrations", exact: true });
  await list.getByRole("button", { name: /Penetration 1 / }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await list.getByRole("button", { name: /Penetration 2 / }).click();
  await page.getByRole("button", { name: "Accept", exact: true }).click();
  await list.getByRole("button", { name: /Penetration 3 / }).click();
  await expect(page.getByText("Outside the assigned roof area; verify scope or reassign.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await list.getByRole("button", { name: /Penetration 4 / }).click();
  await expect(page.getByText("Outside the drawn roof or inside a cutout; verify scope.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  await list.getByRole("button", { name: /Penetration 1 / }).click();
  await page.getByLabel("Penetration label").fill("Reviewed rooflight");
  await page.getByLabel("top", { exact: true }).fill("401.125");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByRole("button", { name: "Confirm association", exact: true }).click();
  const corrected = (await first.getAttribute("data-box"))!;
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await assertAlignment(page, first);
  await page.getByTestId("roi-viewport").evaluate((element) => { element.scrollLeft = 65; element.scrollTop = 30; });
  await assertAlignment(page, first);
  await expect(first).toHaveAttribute("data-box", corrected);
  await page.getByRole("button", { name: "Fit page", exact: true }).click();
  expect(await source.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(pristine);
  expect((await canvasInk(source)).dark).toBeGreaterThan(100);
  expect((await canvasInk(source)).red).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("penetration-review-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await assertAlignment(page, first);
  const labelBounds = await page.getByTestId("annotation-overlay").locator("span").evaluateAll((labels) => labels.map((label) => {
    const bounds = label.getBoundingClientRect();
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
  }));
  labelBounds.forEach((bounds, index) => labelBounds.slice(index + 1).forEach((other) => {
    expect(bounds.left < other.right && bounds.right > other.left && bounds.top < other.bottom && bounds.bottom > other.top).toBe(false);
  }));
  expect((await canvasInk(source)).dark).toBeGreaterThan(100);
  await page.screenshot({ path: testInfo.outputPath("penetration-review-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole("button", { name: "Run detection again", exact: true }).click();
  await expect(page.getByTestId("annotation-box-child-3-1")).toBeVisible();
  await expect(first).toHaveAttribute("data-status", "accepted");
  await expect(first).toHaveAttribute("data-box", corrected);
  await list.getByRole("button", { name: /Penetration 5 / }).click();
  await expect(page.getByText("Possible duplicate; reconcile with existing annotation", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const summary = page.getByRole("region", { name: "Penetration annotation summary" });
  await expect(summary).toContainText("Reviewed rooflight");
  await expect(summary.locator('[data-roi-id="roof-1-1"]')).toContainText("accepted / Current");
  await expect(summary.locator('[data-roi-id="roof-1-2"]')).toContainText("accepted / Current");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(first).toHaveAttribute("data-box", corrected);
  await expect(first).toHaveAttribute("data-status", "accepted");
  expect(networkGuard.submissions).toEqual([]);
});

test("Penetrations: empty, offline, cancelled and manual review routes remain usable", async ({ page, networkGuard }) => {
  test.setTimeout(120_000);
  const api = await mockRoi(page);
  await enterPenetrations(page);
  api.setMode("no_detections");
  await page.getByRole("button", { name: "Detect penetrations", exact: true }).click();
  await expect(page.getByText(/No penetrations returned/)).toBeVisible();
  api.setMode("offline");
  networkGuard.expectedConsoleErrors.push("Failed to load resource: the server responded with a status of 503 (Service Unavailable)");
  await page.getByRole("button", { name: "Run detection again", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("service is unavailable");
  api.setMode("delayed");
  await page.getByRole("button", { name: "Retry detection", exact: true }).click();
  await expect.poll(() => api.requests.length).toBe(4);
  await page.getByRole("button", { name: "Cancel detection", exact: true }).click();
  api.release();
  await expect(page.getByText(/Detection cancelled/)).toBeVisible();
  await page.getByRole("button", { name: "Manual penetration", exact: true }).click();
  const source = (await page.getByTestId("roi-source-canvas").boundingBox())!;
  await page.mouse.move(source.x + source.width * 0.18, source.y + source.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(source.x + source.width * 0.22, source.y + source.height * 0.45, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByRole("button", { name: "Confirm association", exact: true })).toBeDisabled();
  await page.getByLabel("Parent roof area").selectOption("roof-1-1");
  await page.getByRole("combobox", { name: "Subtype", exact: true }).selectOption("vent");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByRole("button", { name: "Confirm association", exact: true }).click();
  await expect(page.getByRole("list", { name: "Penetrations", exact: true })).toContainText("accepted / Manual");
  await page.getByRole("button", { name: "Delete penetration", exact: true }).click();
  await page.getByRole("button", { name: "Undo review edit", exact: true }).click();
  await expect(page.getByRole("list", { name: "Penetrations", exact: true })).toContainText("accepted / Manual");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("button", { name: "Upload Another PDF", exact: true })).toBeVisible();
});

test("Penetrations: no accepted parents disables networking but permits manual continuation", async ({ page }) => {
  test.setTimeout(120_000);
  const api = await mockRoi(page);
  await enterPenetrations(page, false);
  await expect(page.getByRole("button", { name: "Detect penetrations", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Manual penetration", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByRole("region", { name: "Penetration annotation summary" })).toContainText("No penetration annotations.");
  expect(api.requests).toEqual([]);
  expect(api.uploads).toEqual([]);
});

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
