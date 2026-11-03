import type { Locator, Page, TestInfo } from "@playwright/test";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { strFromU8, unzipSync } from "fflate";
import { test, expect } from "./fixtures";
import { createRoofPlanPdf, createSpecificationPdf } from "../fixtures/roofPlan";

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

async function magentaOutletPixels(canvas: Locator) {
  return canvas.evaluate((element: HTMLCanvasElement) => {
    const pixels = element.getContext("2d")!.getImageData(0, 0, element.width, element.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const r = pixels[index], g = pixels[index + 1], b = pixels[index + 2];
      if (r > g + 25 && b > g + 20 && r > b + 5) count++;
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
}

test("New Build: PDF pages, manual fill/undo, zoom, outlet and package download", async ({ page, networkGuard }, testInfo) => {
  test.setTimeout(120_000);
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
  const paint = page.locator("canvas").nth(-2);
  const interaction = page.locator("canvas").last();
  const accepted = page.getByTestId("accepted-outline-overlay");
  await expect(accepted).toHaveCount(0);
  await clickCanvas(interaction, 0.7, 0.5);
  await expect(next).toBeEnabled();
  await expect(accepted).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(next).toBeDisabled();
  await expect(accepted).toHaveCount(0);
  await clickCanvas(interaction, 0.7, 0.5);
  await expect(next).toBeEnabled();
  const paintedImage = await paint.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const outlinePoints = await accepted.locator("[data-accepted-outline]").getAttribute("points");
  const fitWidth = await paint.evaluate((canvas) => canvas.getBoundingClientRect().width);
  await page.getByTitle("Zoom in", { exact: true }).click();
  await expect.poll(() => paint.evaluate((canvas) => canvas.getBoundingClientRect().width)).toBeGreaterThan(fitWidth);
  expect(await paint.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(paintedImage);
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", outlinePoints!);
  await page.getByTitle("Fit to screen", { exact: true }).click();
  await capture(page, testInfo, "new-build-manual-roof");

  await next.click();
  await expect(page.getByRole("heading", { name: "Outlets & Drainage" })).toBeVisible();
  const outletCanvas = page.locator("canvas");
  const originalMagentaPixels = await magentaOutletPixels(outletCanvas);
  await clickCanvas(outletCanvas, 0.7, 0.5);
  await expect(page.getByText(/^Outlet 1\b/)).toBeVisible();
  await expect.poll(() => magentaOutletPixels(outletCanvas)).toBeGreaterThan(originalMagentaPixels);
  await capture(page, testInfo, "new-build-outlet");
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  await expect(accepted).toBeVisible();
  await clickCanvas(interaction, 0.7, 0.5);
  await expect(next).toBeDisabled();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(next).toBeEnabled();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(await createRoofPlanPdf());
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(preview).toHaveAttribute("src", firstPage!);
  await next.click();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  await expect(next).toBeDisabled();
  await expect(accepted).toHaveCount(0);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles(await createRoofPlanPdf());
  await expect(page.getByText("1 / 2", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "\u2192", exact: true }).click();
  await expect(preview).toHaveAttribute("src", secondPage!);
  await next.click();
  await expect(page.getByRole("button", { name: "Select", exact: true })).toBeEnabled();
  await expect(next).toBeEnabled();
  await expect(accepted).toBeVisible();
  await capture(page, testInfo, "new-build-restored-page");
  await next.click();
  await expect(page.getByText(/^Outlet 1\b/)).toBeVisible();
  await next.click();
  await expect(page.getByRole("heading", { name: "Project Details", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Complete", exact: true })).toBeDisabled();
  await fillDetails(page);
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await expect(page.getByText(/^Outlet 1\b/)).toBeVisible();
  await next.click();
  await expect(page.getByLabel("Project Name *", { exact: true })).toHaveValue("Phase 0 synthetic roof");
  await capture(page, testInfo, "new-build-project-details");
  const send = page.getByRole("button", { name: "Send to TaperedPlus", exact: true });
  await expect(send).toBeDisabled();
  await expect(page.getByText("Sending to TaperedPlus is coming soon.", { exact: true })).toBeVisible();

  const specification = await createSpecificationPdf();
  await page.getByLabel("Performance specification PDF", { exact: true }).setInputFiles(specification);
  await expect(page.getByTestId("spec-document-name")).toHaveText(specification.name);
  await expect(page.getByText(/Target U-Value|Product Type|Deck Type|Waterproofing Type/)).toHaveCount(0);
  const downloadButton = page.getByRole("button", { name: "Download package (.zip)", exact: true });
  await expect(downloadButton).toBeEnabled();
  await capture(page, testInfo, "new-build-package-ready");
  const downloadEvent = page.waitForEvent("download");
  await downloadButton.click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toMatch(/^TPID_Phase_0_synthetic_roof_\d{8}-\d{4}\.zip$/);
  const files = unzipSync(new Uint8Array(await readFile(await download.path())));
  expect(Object.keys(files).sort()).toEqual([
    `1_spec/${specification.name}`,
    "2_details/project_details.csv",
    "3_roof_plan/synthetic-two-page-roof.pdf",
    "4_drawing/roof_drawing.png",
    "4_drawing/roof_mask.png",
    "4_drawing/roof_metadata.json",
    "4_drawing/roof_outline.dxf",
    "4_drawing/roof_outline.geojson",
    "4_drawing/roof_outline.svg",
    "4_drawing/roof_plan_marked_up_p2.png",
    "5_prompt/TRICS_design_prompt.md",
    "manifest.json",
  ]);
  expect(Buffer.from(files[`1_spec/${specification.name}`]).equals(specification.buffer)).toBe(true);
  expect(Buffer.from(files["3_roof_plan/synthetic-two-page-roof.pdf"]).equals((await createRoofPlanPdf()).buffer)).toBe(true);
  for (const png of ["roof_drawing.png", "roof_mask.png", "roof_plan_marked_up_p2.png"]) {
    expect([...files[`4_drawing/${png}`].slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }
  const csv = strFromU8(files["2_details/project_details.csv"]);
  expect(csv).toContain("projectName,Project Name,Phase 0 synthetic roof\r\n");
  expect(csv).toContain("projectAddress,Project Address (Including Postcode),Synthetic test address\r\n");
  expect(csv).not.toContain("targetUValue");
  expect(strFromU8(files["4_drawing/roof_outline.dxf"])).toContain("AC1009");
  const metadata = JSON.parse(strFromU8(files["4_drawing/roof_metadata.json"]));
  expect(metadata).toMatchObject({ units: "mm", totals: { roof_areas: 1, outlets: 1 } });
  expect(metadata.totals.net_area_m2).toBeGreaterThan(0);
  expect(strFromU8(files["5_prompt/TRICS_design_prompt.md"])).toContain(`\`1_spec/${specification.name}\``);
  expect(JSON.parse(strFromU8(files["manifest.json"]))).toMatchObject({ performance_specification_supplied: true });
  expect(networkGuard.submissions).toHaveLength(0);
});

test("New Build: selection sensitivity preserves geometry and fits desktop and mobile", async ({ page }, testInfo) => {
  await page.goto("/new-build");
  await page.locator('input[type="file"]').setInputFiles(await createRoofPlanPdf());
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(next).toBeEnabled({ timeout: 30_000 });
  await next.click();
  const slider = page.getByRole("slider", { name: "Selection sensitivity", exact: true });
  await expect(slider).toBeEnabled();
  await expect(slider).toHaveValue("45");
  await expect(slider).toHaveAttribute("min", "1");
  await expect(slider).toHaveAttribute("max", "100");
  const paint = page.getByTestId("paint-source-canvas");
  const interaction = page.getByTestId("paint-interaction-canvas");
  const accepted = page.getByTestId("accepted-outline-overlay");
  await clickCanvas(interaction, 0.25, 0.5);
  await expect(accepted).toBeVisible();
  await page.getByTitle("Zoom in", { exact: true }).click();
  const paintedImage = await paint.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
  const outlinePoints = await accepted.locator("[data-accepted-outline]").getAttribute("points");
  const zoomWidth = await paint.evaluate(canvas => canvas.getBoundingClientRect().width);
  await slider.focus();
  await slider.press("Home");
  for (let step = 0; step < 9; step++) await slider.press("ArrowRight");
  await expect(slider).toHaveValue("10");
  expect(await paint.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).toBe(paintedImage);
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", outlinePoints!);
  expect(await paint.evaluate(canvas => canvas.getBoundingClientRect().width)).toBe(zoomWidth);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Cut Out", exact: true }).click();
  await expect(slider).not.toBeVisible();
  await expect(page.getByRole("slider", { name: "Cut Out sensitivity", exact: true })).toHaveValue("40");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(slider).toHaveValue("10");
  await page.getByRole("button", { name: "Default (45)", exact: true }).click();
  await expect(slider).toHaveValue("45");
  await page.screenshot({ path: testInfo.outputPath("selection-sensitivity-desktop.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await slider.scrollIntoViewIfNeeded();
  const row = page.getByText("Selection sensitivity", { exact: true }).locator("..");
  const controls = await row.locator("label, input, output, button").evaluateAll(elements =>
    elements.map(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    })
  );
  for (const [index, control] of controls.entries()) {
    expect(control.left).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(390);
    for (const other of controls.slice(index + 1)) {
      expect(control.right <= other.left || other.right <= control.left ||
        control.bottom <= other.top || other.bottom <= control.top).toBe(true);
    }
  }
  await expect(accepted).toBeVisible();
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", outlinePoints!);
  await page.screenshot({ path: testInfo.outputPath("selection-sensitivity-mobile.png"), fullPage: true });
  await slider.press("End");
  await expect(slider).toHaveValue("100");
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(accepted).toHaveCount(0);
  await expect(next).toBeDisabled();
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
