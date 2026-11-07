import { createHash } from "node:crypto";
import { test, expect } from "./fixtures";
import { createPenetrationPlanPdf, createRedrawPlanPdf } from "../fixtures/roofPlan";
import type { OutlineRequest, OutlineResponse } from "../../src/types/outline";
import type { PageContext } from "../../src/types/roi";

test("generates a reviewable stepped outline, applies without filling its notch, and undoes atomically", async ({ page }, testInfo) => {
  const requests: OutlineRequest[] = [];
  const uploads: Buffer[] = [];
  let context: PageContext | undefined;
  const points = [{ x: 60, y: 320 }, { x: 140, y: 320 }, { x: 140, y: 200 },
    { x: 260, y: 200 }, { x: 260, y: 120 }, { x: 60, y: 120 }];
  const steppedSide = [{ x: 390, y: 40 }, { x: 504, y: 40 }, { x: 504, y: 46 },
    { x: 512, y: 46 }, { x: 511, y: 70 }, { x: 510, y: 100 }, { x: 390, y: 100 }];
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
    const proposalPoints = payload.roi.id === secondRoiId
      ? steppedSide
      : points;
    const response: OutlineResponse = {
      schema_version: "outline-1", page_id: payload.page_id, request_id: payload.request_id,
      source_image_hash: payload.source_image_hash, roi_revision: payload.roi_revision,
      geometry_revision: payload.geometry_revision, roi_id: payload.roi.id, roi_annotation_revision: payload.roi.revision,
      boundary_policy: payload.boundary_policy, status: "needs_review",
      proposals: [{ id: `outline-${requests.length}`, points: proposalPoints, proposed_points: proposalPoints, warnings: [],
        edges: proposalPoints.map((_, index) => ({ index, support: index === 2 ? 0.3 : 1, source: "vector", ambiguous: index === 2 })) }],
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
  await page.getByLabel("Region label", { exact: true }).fill("roof_roi");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByRole("button", { name: "Manual region", exact: true }).click();
  await page.mouse.move(bounds.x + bounds.width * 0.62, bounds.y + bounds.height * 0.07);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.88, bounds.y + bounds.height * 0.28);
  await page.mouse.up();
  await page.getByLabel("Region label", { exact: true }).fill("roof_roi");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByRole("button", { name: "Set Outlines", exact: true }).click();
  const regionSelect = page.getByRole("combobox", { name: "Select roof area to outline", exact: true });
  await expect(regionSelect.getByRole("option")).toHaveText(["Roof area 1", "Roof area 2"]);
  const secondRoiId = await regionSelect.inputValue();
  const targetLabel = page.getByTestId("annotation-overlay").locator('[aria-current="true"]');
  await expect(targetLabel).toHaveText("Roof area 2");
  await expect(page.getByRole("button", { name: "Generate Roof area 2 outline", exact: true })).toBeVisible();
  await testInfo.attach("outline-target", { body: await page.screenshot(), contentType: "image/png" });
  await regionSelect.selectOption({ label: "Roof area 1" });
  const firstRoiId = await regionSelect.inputValue();
  await expect(targetLabel).toHaveText("Roof area 1");
  const next = page.getByRole("button", { name: "Next", exact: true });
  await expect(page.getByRole("button", { name: "Straighten", exact: true })).toHaveCount(0);
  await expect(next).toBeDisabled();
  expect(requests).toHaveLength(0);
  await page.getByLabel("Boundary to follow", { exact: true }).selectOption("inner_parapet");
  await page.getByRole("button", { name: "Generate Roof area 1 outline", exact: true }).click();
  const overlay = page.getByTestId("outline-proposal-overlay");
  await expect(overlay).toBeVisible();
  await expect(next).toBeDisabled();
  expect(requests).toHaveLength(1);
  expect(requests[0].roi.id).toBe(firstRoiId);
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
  // The next roof area that still needs an outline is selected automatically.
  await expect(regionSelect).toHaveValue(secondRoiId);
  await expect(targetLabel).toHaveText("Roof area 2");
  await expect(regionSelect.getByRole("option")).toHaveText(["Roof area 1 (outlined)", "Roof area 2"]);
  await expect(page.getByTestId("outline-progress")).toHaveText("1 of 2 roof areas outlined. Still to outline: Roof area 2.");
  await expect(page.getByRole("button", { name: "Adjust", exact: true })).toBeEnabled();
  const accepted = page.getByTestId("accepted-outline-overlay");
  await expect(accepted).toBeVisible();
  await expect(accepted.locator("[data-outline-vertex]")).toHaveCount(0);
  const selection = await accepted.evaluate(async (element: SVGSVGElement) => {
    // Sample the browser-rendered SVG: the notch and subsequently cut holes must stay transparent.
    const copy = element.cloneNode(true) as SVGSVGElement;
    copy.setAttribute("width", String(element.viewBox.baseVal.width));
    copy.setAttribute("height", String(element.viewBox.baseVal.height));
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
    try {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const inside = Array.from(context.getImageData(80, 250, 1, 1).data);
      return { inside, notch: context.getImageData(200, 270, 1, 1).data[3] };
    } finally { URL.revokeObjectURL(url); }
  });
  expect(selection.inside[2]).toBeGreaterThan(selection.inside[0] + 100);
  expect(selection.inside[3]).toBeGreaterThanOrEqual(14);
  expect(selection.inside[3]).toBeLessThanOrEqual(16);
  expect(selection.notch).toBe(0);
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("stroke", "#2563eb");
  const acceptedPoints = await accepted.locator("[data-accepted-outline]").getAttribute("points");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const zoomedSource = (await page.getByTestId("paint-source-canvas").boundingBox())!;
  const zoomedOverlay = (await accepted.boundingBox())!;
  for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(zoomedSource[key] - zoomedOverlay[key])).toBeLessThan(1);
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", acceptedPoints!);
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("stroke-width", "2");
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("vector-effect", "non-scaling-stroke");
  await testInfo.attach("accepted-outline", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await expect(accepted.locator("[data-outline-vertex]")).toHaveCount(points.length);
  const adjust = page.getByRole("button", { name: "Adjust", exact: true });
  const adjustTools = page.getByRole("group", { name: "Adjust tools", exact: true });
  const straighten = adjustTools.getByRole("button", { name: "Straighten", exact: true });
  await expect(adjustTools.getByRole("button", { name: "Snap to line", exact: true })).toBeVisible();
  await testInfo.attach("accepted-outline-adjust", { body: await page.screenshot(), contentType: "image/png" });
  await straighten.click();
  await expect(adjust).toHaveAttribute("aria-pressed", "true");
  await expect(straighten).toHaveAttribute("aria-pressed", "true");
  await expect(accepted.locator("[data-outline-vertex]")).toHaveCount(0);
  await testInfo.attach("adjust-straighten", { body: await page.screenshot(), contentType: "image/png" });
  await straighten.click();
  await expect(straighten).toHaveAttribute("aria-pressed", "false");
  await expect(accepted.locator("[data-outline-vertex]")).toHaveCount(points.length);
  await straighten.click();
  await page.keyboard.press("Escape");
  await expect(straighten).toHaveAttribute("aria-pressed", "false");
  await expect(adjust).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Select", exact: true }).click();
  await expect(adjustTools).toHaveCount(0);
  await expect(accepted.locator("[data-outline-vertex]")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo generated outline", exact: true }).click();
  await expect(accepted).toHaveCount(0);
  await expect(next).toBeDisabled();
  await expect(regionSelect).toHaveValue(firstRoiId);
  await page.getByRole("button", { name: "Generate Roof area 1 outline", exact: true }).click();
  await expect(overlay).toBeVisible();
  expect(uploads).toHaveLength(2);
  expect(uploads[1]).toEqual(uploads[0]);
  await page.getByLabel("Boundary to follow", { exact: true }).selectOption("roof_deck");
  await expect(overlay).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use outline", exact: true })).toHaveCount(0);
  await regionSelect.selectOption({ label: "Roof area 2" });
  await expect(targetLabel).toHaveText("Roof area 2");
  await page.getByRole("button", { name: "Generate Roof area 2 outline", exact: true }).click();
  await expect(overlay).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[2].roi.id).toBe(secondRoiId);
  await page.getByRole("button", { name: "Use outline", exact: true }).click();
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByRole("button", { name: "Snap to line", exact: true }).click();
  const fitSurface = page.getByTestId("side-fit-overlay");
  const clickFit = async (x: number, y: number) => {
    const box = (await fitSurface.boundingBox())!;
    await page.mouse.click(box.x + x / 600 * box.width, box.y + y / 400 * box.height);
  };
  await clickFit(504, 40);
  await clickFit(510, 100);
  await clickFit(510, 75);
  await expect(page.getByTestId("side-fit-target")).toHaveAttribute("data-source", "vector");
  await expect(page.getByTestId("side-fit-preview")).toHaveAttribute("points", "390,40 510,40 510,100 390,100");
  await expect(accepted.locator("[data-outline-vertex]")).toHaveCount(7);
  await straighten.click();
  await expect(fitSurface).toHaveCount(0);
  await expect(adjust).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Snap to line", exact: true }).click();
  await expect(straighten).toHaveAttribute("aria-pressed", "false");
  await clickFit(504, 40);
  await clickFit(510, 100);
  await clickFit(510, 75);
  await expect(page.getByTestId("side-fit-preview")).toHaveAttribute("points", "390,40 510,40 510,100 390,100");
  await testInfo.attach("fit-side-preview", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Apply fit", exact: true }).click();
  // Snap to line stays on for the next side; only the finished selection is cleared.
  await expect(page.getByTestId("side-fit-section")).toHaveCount(0);
  await expect(fitSurface).toBeVisible();
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", "390,40 510,40 510,100 390,100");
  await expect(accepted.locator("[data-outline-vertex]")).toHaveCount(4);
  await testInfo.attach("fit-side-applied", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", steppedSide.map(p => `${p.x},${p.y}`).join(" "));
  // Drag the stepped side onto the drawn edge: the preview follows the pointer and release applies it.
  const fitPoint = async (x: number, y: number): Promise<[number, number]> => {
    const box = (await fitSurface.boundingBox())!;
    return [box.x + x / 600 * box.width, box.y + y / 400 * box.height];
  };
  await page.mouse.move(...await fitPoint(511.5, 58));
  await expect(page.getByTestId("side-fit-grab")).toHaveAttribute("points", "512,46 511,70 510,100");
  await page.mouse.down();
  await page.mouse.move(...await fitPoint(530, 75), { steps: 4 });
  await expect(page.getByTestId("side-fit-target")).toHaveCount(0);
  await page.mouse.move(...await fitPoint(510, 75), { steps: 4 });
  await expect(page.getByTestId("side-fit-target")).toHaveAttribute("data-source", "vector");
  const draggedSide = "390,40 504,40 504,46 510,46 510,100 390,100";
  await expect(page.getByTestId("side-fit-preview")).toHaveAttribute("points", draggedSide);
  await testInfo.attach("fit-side-drag-preview", { body: await page.screenshot(), contentType: "image/png" });
  await page.mouse.up();
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", draggedSide);
  await expect(page.getByTestId("side-fit-section")).toHaveCount(0);
  await expect(fitSurface).toBeVisible();
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(accepted.locator("[data-accepted-outline]")).toHaveAttribute("points", steppedSide.map(p => `${p.x},${p.y}`).join(" "));
  await clickFit(504, 40);
  await page.keyboard.press("Escape");
  await expect(fitSurface).toHaveCount(0);
  expect(requests).toHaveLength(3); // Fitting uses the uploaded drawing locally, without another model request.
});

for (const automatic of [false, true]) {
test(automatic
  ? "finishes and applies a redraw on one click at a PDF endpoint matching an existing outline vertex"
  : "redraws a missing rotated return using PDF vector snaps and restores it with one undo", async ({ page }, testInfo) => {
  const plan = await createRedrawPlanPdf(automatic);
  const requests: OutlineRequest[] = [];
  await page.route("http://127.0.0.1:4199/api/roi/v1/**", async route => {
    const request = route.request();
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, OPTIONS" };
    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    if (request.url().endsWith("/pages")) {
      const form = await new Response(new Uint8Array(request.postDataBuffer()!), {
        headers: { "content-type": request.headers()["content-type"] },
      }).formData();
      return route.fulfill({ headers, json: { page: JSON.parse(String(form.get("context"))), upload_id: "redraw-upload", expires_in_seconds: 900 } });
    }
    expect(request.url()).toMatch(/\/outlines$/);
    const payload = request.postDataJSON() as OutlineRequest;
    requests.push(payload);
    const response: OutlineResponse = {
      schema_version: "outline-1", page_id: payload.page_id, request_id: payload.request_id,
      source_image_hash: payload.source_image_hash, roi_revision: payload.roi_revision,
      geometry_revision: payload.geometry_revision, roi_id: payload.roi.id, roi_annotation_revision: payload.roi.revision,
      boundary_policy: payload.boundary_policy, status: "needs_review",
      proposals: [{ id: "missing-return", points: plan.original, proposed_points: plan.original, warnings: [],
        edges: plan.original.map((_, index) => ({ index, support: 1, source: "vector", ambiguous: false })) }],
      warnings: [], crop: { x: 0, y: 0, width: 600, height: 400, inference_width: 600, inference_height: 400 },
      run: { model: "synthetic", prompt_version: "roof-outline-v1", algorithm_version: "redraw-fixture",
        settings: {}, duration_ms: 1, cached: false, provider_attempts: 1 },
    };
    return route.fulfill({ headers, json: response });
  });
  await page.goto("/new-build");
  await page.locator('input[type="file"]').setInputFiles(plan.file);
  await expect(page.getByRole("button", { name: "Next", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Manual region", exact: true }).click();
  const bounds = (await page.getByTestId("roi-source-canvas").boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.05, bounds.y + bounds.height * 0.05);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.95, bounds.y + bounds.height * 0.95);
  await page.mouse.up();
  await page.getByLabel("Region label", { exact: true }).fill("roof_roi");
  await page.getByRole("button", { name: "Apply correction", exact: true }).click();
  await page.getByRole("button", { name: "Set Outlines", exact: true }).click();
  await page.getByRole("button", { name: "Generate Roof area 1 outline", exact: true }).click();
  await page.getByRole("button", { name: "Use outline", exact: true }).click();
  expect(requests).toHaveLength(1);
  expect(requests[0].vector_segments.length).toBeGreaterThanOrEqual(6);
  await page.getByRole("button", { name: "Adjust", exact: true }).click();
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await page.getByRole("button", { name: "Redraw", exact: true }).click();
  const surface = page.getByTestId("polyline-redraw-overlay");
  const accepted = page.getByTestId("accepted-outline-overlay").locator("[data-accepted-outline]");
  const before = await accepted.getAttribute("points");
  const screenPoint = async ({ x, y }: { x: number; y: number }) => {
    const box = (await surface.boundingBox())!;
    return { x: box.x + x / 600 * box.width, y: box.y + y / 400 * box.height };
  };
  const start = await screenPoint(plan.start);
  await page.mouse.click(start.x, start.y);
  const corner = await screenPoint(plan.corner);
  await page.mouse.move(corner.x + 1, corner.y - 1);
  await expect(page.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "endpoint");
  await page.mouse.click(corner.x + 1, corner.y - 1);
  const end = await screenPoint(plan.end);
  if (automatic) {
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await page.mouse.move(end.x + 1, end.y - 1);
    await expect(page.getByTestId("polyline-redraw-cursor")).toHaveAttribute("data-snap", "finish");
    await expect(page.getByText("Click to finish and apply", { exact: true })).toBeVisible();
    await expect(page.getByTestId("polyline-redraw-preview")).toBeVisible();
    await expect(page.getByTestId("polyline-redraw-section")).toBeVisible();
    await expect(accepted).toHaveAttribute("points", before!);
    await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
    await testInfo.attach("endpoint-match-before-click", { body: await page.screenshot(), contentType: "image/png" });
    await page.mouse.click(end.x + 1, end.y - 1);
    await expect(page.getByRole("button", { name: "Apply redraw", exact: true })).toHaveCount(0);
  } else {
    await page.getByRole("button", { name: "Finish on outline", exact: true }).click();
    await page.mouse.click(end.x, end.y);
    await expect(page.getByTestId("polyline-redraw-preview")).toBeVisible();
    await expect(accepted).toHaveAttribute("points", before!);
    await testInfo.attach("rotated-return-redraw-preview", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Apply redraw", exact: true }).click();
  }
  await expect(accepted).not.toHaveAttribute("points", before!);
  const actual = (await accepted.getAttribute("points"))!.split(" ").map(pair => pair.split(",").map(Number));
  expect(actual).toHaveLength(plan.corrected.length);
  if (automatic) expect(actual).toContainEqual([plan.original[3].x, plan.original[3].y]);
  for (const point of plan.corrected) {
    expect(actual.some(([x, y]) => Math.hypot(x - point.x, y - point.y) < 0.0001)).toBe(true);
  }
  await testInfo.attach("rotated-return-redraw-applied", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(accepted).toHaveAttribute("points", before!);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Generate Roof area 1 outline", exact: true })).toBeVisible();
  expect(requests).toHaveLength(1); // Redrawing and undo never call a model or backend.
});
}
