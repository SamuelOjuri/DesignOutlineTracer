import type { Locator, Page, TestInfo } from "@playwright/test";
import { test, expect } from "./fixtures";
import { createRoofPlanPdf } from "../fixtures/roofPlan";

async function clickCanvas(canvas: Locator, horizontal: number, vertical: number) {
  const size = await canvas.boundingBox();
  expect(size).not.toBeNull();
  await canvas.click({ position: { x: size!.width * horizontal, y: size!.height * vertical } });
}

async function redPixels(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index] > 140 && pixels[index + 1] < 130 && pixels[index + 2] < 130 && pixels[index + 3] > 0) count++;
    }
    return count;
  });
}

async function capture(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
}

async function fillDetails(page: Page) {
  await page.getByLabel("Name *", { exact: true }).fill("Regression Tester");
  await page.getByLabel("Company *", { exact: true }).fill("Synthetic Test Company");
  await page.getByLabel("Email Address *", { exact: true }).fill("regression@example.invalid");
  await page.getByLabel("Project Name *", { exact: true }).fill("Phase 0 synthetic roof");
  await page.getByLabel("Project Address (Including Postcode) *", { exact: true }).fill("Synthetic test address");
  await page.getByLabel("Target U-Value *", { exact: true }).fill("0.18");
}

test("New Build: PDF pages, manual fill/undo, zoom, outlet and mocked submission", async ({ page, networkGuard }, testInfo) => {
  await page.goto("/new-build");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous", exact: true })).toBeDisabled();
  await page.locator('input[type="file"]').setInputFiles(await createRoofPlanPdf());
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(next).toBeEnabled();
  const preview = page.getByRole("img", { name: "PDF Preview", exact: true }).last();
  const firstPage = await preview.getAttribute("src");
  await expect(preview).toHaveJSProperty("naturalWidth", 600);
  await expect(preview).toHaveJSProperty("naturalHeight", 400);
  await page.getByRole("button", { name: "\u2192", exact: true }).click();
  await expect(page.getByText("2 / 2", { exact: true })).toBeVisible();
  await expect(preview).not.toHaveAttribute("src", firstPage!);
  const secondPage = await preview.getAttribute("src");
  await page.getByRole("button", { name: "\u2190", exact: true }).click();
  await expect(preview).toHaveAttribute("src", firstPage!);
  await page.getByRole("button", { name: "\u2192", exact: true }).click();
  await expect(preview).toHaveAttribute("src", secondPage!);
  await capture(page, testInfo, "new-build-page-selection");

  await next.click();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  await expect(next).toBeDisabled();
  const paint = page.locator("canvas").first();
  const interaction = page.locator("canvas").last();
  expect(await redPixels(paint)).toBe(0);
  await clickCanvas(interaction, 0.7, 0.5);
  await expect(next).toBeEnabled();
  await expect.poll(() => redPixels(paint)).toBeGreaterThan(100);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(next).toBeDisabled();
  await expect.poll(() => redPixels(paint)).toBe(0);
  await clickCanvas(interaction, 0.7, 0.5);
  await expect(next).toBeEnabled();
  const paintedImage = await paint.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const fitWidth = await paint.evaluate((canvas) => canvas.getBoundingClientRect().width);
  await page.getByTitle("Zoom in", { exact: true }).click();
  await expect.poll(() => paint.evaluate((canvas) => canvas.getBoundingClientRect().width)).toBeGreaterThan(fitWidth);
  expect(await paint.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(paintedImage);
  await page.getByTitle("Fit to screen", { exact: true }).click();
  await capture(page, testInfo, "new-build-manual-roof");

  await next.click();
  await expect(page.getByRole("heading", { name: "Outlets & Drainage" })).toBeVisible();
  const outletCanvas = page.locator("canvas");
  const outlinePixels = await redPixels(outletCanvas);
  await clickCanvas(outletCanvas, 0.7, 0.5);
  await expect(page.getByText(/^Outlet 1\b/)).toBeVisible();
  await expect.poll(() => redPixels(outletCanvas)).toBeGreaterThan(outlinePixels);
  await capture(page, testInfo, "new-build-outlet");
  await next.click();
  await expect(page.getByRole("heading", { name: "Project Details", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete", exact: true })).toBeDisabled();
  await fillDetails(page);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText(/^Outlet 1\b/)).toBeVisible();
  await next.click();
  await expect(page.getByLabel("Project Name *", { exact: true })).toHaveValue("Phase 0 synthetic roof");
  await capture(page, testInfo, "new-build-project-details");
  expect(networkGuard.submissions).toHaveLength(0);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Send to TaperedPlus", exact: true }).click();
  await expect.poll(() => networkGuard.submissions.length).toBe(1);
  expect(networkGuard.submissions[0]).toMatchObject({
    outline: [expect.objectContaining({ polygonPoints: expect.any(Array) })],
    outlets: [expect.objectContaining({ x: expect.any(Number), y: expect.any(Number), diameter: 0.15 })],
    penetrations: [],
    projectDetails: { projectName: "Phase 0 synthetic roof" },
  });
});

test("Refurbishment: dimensioned outline, outlet and details without services", async ({ page, networkGuard }, testInfo) => {
  await page.goto("/refurbishment");
  await expect(page.getByRole("heading", { name: "Roof Outline Builder" })).toBeVisible();
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeDisabled();
  await page.getByRole("spinbutton").fill("10");
  for (const direction of ["right", "down", "left", "up"]) {
    await page.locator(`button:has(svg.lucide-arrow-${direction})`).click();
  }
  await expect(next).toBeEnabled();
  const canvas = page.locator("canvas");
  await expect.poll(() => redPixels(canvas)).toBeGreaterThan(100);
  await capture(page, testInfo, "refurbishment-manual-outline");
  await next.click();
  await page.getByRole("button", { name: "Add Outlets", exact: true }).click();
  const beforeOutlet = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
  await clickCanvas(canvas, 0.5, 0.5);
  await expect(page.getByText(/^Outlet 1\b/)).toBeVisible();
  expect(await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL())).not.toBe(beforeOutlet);
  await capture(page, testInfo, "refurbishment-outlet");
  await next.click();
  await expect(page.getByRole("heading", { name: "Penetrations", exact: true })).toBeVisible();
  await next.click();
  await expect(page.getByRole("heading", { name: "Project Details", exact: true })).toBeVisible();
  await fillDetails(page);
  await capture(page, testInfo, "refurbishment-project-details");
  expect(networkGuard.submissions).toHaveLength(0);
});