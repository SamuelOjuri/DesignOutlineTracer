import { test, expect } from "./fixtures";
import { tp17221Illustration, tp17221BoundaryIllustration, tp17221FittedInlets } from "../fixtures/roofAppearance";

for (const [example, fixture] of [["1833", tp17221Illustration], ["1915", tp17221BoundaryIllustration],
  ["source-fitted", tp17221FittedInlets]] as const) {
  test(`confirmed openings are solid and the example roof has five equally sized outlet symbols (${example})`, async ({ page }, testInfo) => {
    await page.goto("/new-build");
    const measurements = await page.evaluate(async (data) => {
      const modulePath = "/src/utils/roofRender.ts";
      const renderer = await import(modulePath) as {
        illustrationBounds(outlines: typeof data.roofOutlines, outlets: typeof data.outlets):
          { minX: number; minY: number; w: number; h: number };
        drawRoofIllustration(ctx: CanvasRenderingContext2D, drawing: typeof data, options: {
          width: number; height: number; offset: { x: number; y: number }; displayScale: number; grid: boolean;
        }): void;
        renderDrawingPng(drawing: typeof data): Promise<Blob>;
      };
      const bounds = renderer.illustrationBounds(data.roofOutlines, data.outlets);
      const offset = { x: 60 - bounds.minX, y: 60 - bounds.minY };
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(bounds.w + 120);
      canvas.height = Math.ceil(bounds.h + 120);
      canvas.setAttribute("aria-label", "Example roof drawing");
      document.body.replaceChildren(canvas);
      const ctx = canvas.getContext("2d")!;
      const measureWidths = (context: CanvasRenderingContext2D, imageScale = 1) =>
        data.outlets.map(outlet => {
          const left = Math.floor((outlet.x + offset.x) * imageScale) - 30;
          const top = Math.floor((outlet.y + offset.y) * imageScale) - 30;
          const pixels = context.getImageData(left, top, 60, 60).data;
          const ink: number[] = [];
          for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) {
            const i = (y * 60 + x) * 4;
            if (pixels[i] < 180 && pixels[i + 1] > pixels[i] + 20 && pixels[i + 2] > pixels[i + 1] + 25) ink.push(x);
          }
          return ink.length ? (Math.max(...ink) - Math.min(...ink) + 1) / imageScale : 0;
        });
      const results = [];
      for (const review_status of ["suggested", "accepted"] as const) {
        for (const zoom of [2.28, 1.3, 1, 0.65, 0.27, 0.5]) {
          renderer.drawRoofIllustration(ctx, { ...data, outlets: data.outlets.map(outlet => ({ ...outlet, review_status })) },
            { width: canvas.width, height: canvas.height, offset, displayScale: zoom, grid: false });
          const widths = measureWidths(ctx);
          const coverage = data.interiorHoles.map(hole => {
            const x = Math.round(hole[0].x + offset.x);
            const top = Math.ceil(Math.min(...hole.map(p => p.y)) + offset.y) + 4;
            const bottom = Math.floor(Math.max(...hole.map(p => p.y)) + offset.y) - 4;
            const pixels = ctx.getImageData(x - 2, top, 5, bottom - top).data;
            let filled = 0;
            for (let y = 0; y < bottom - top; y++) {
              if ([0, 1, 2, 3, 4].some(dx => pixels[(y * 5 + dx) * 4] < 180)) filled++;
            }
            return filled / (bottom - top);
          });
          results.push({ zoom, widths, coverage, review_status });
        }
      }
      // Decode the actual export blob too: the screen rendering alone cannot catch missing PNG symbols.
      const bitmap = await createImageBitmap(await renderer.renderDrawingPng(data));
      const exported = document.createElement("canvas");
      exported.width = bitmap.width; exported.height = bitmap.height;
      const exportContext = exported.getContext("2d")!;
      exportContext.drawImage(bitmap, 0, 0); bitmap.close();
      const exportScale = Math.min(4, Math.max(1, 2400 / Math.max(bounds.w + 120, bounds.h + 120)));
      const exportWidths = measureWidths(exportContext, exportScale);
      canvas.style.width = `${canvas.width * 0.5}px`;
      return { results, exportWidths };
    }, fixture());
    for (const { zoom, widths, coverage, review_status } of measurements.results) {
      expect(Math.min(...widths) * zoom, `All five ${review_status} outlets visible at zoom ${zoom}`).toBeGreaterThanOrEqual(8);
      if (review_status === "accepted") expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
      expect(Math.min(...coverage)).toBeGreaterThan(0.98);
    }
    expect(Math.min(...measurements.exportWidths), "All five outlets visible in the exported PNG").toBeGreaterThanOrEqual(8);
    expect(Math.max(...measurements.exportWidths) - Math.min(...measurements.exportWidths)).toBeLessThanOrEqual(2);
    await page.getByLabel("Example roof drawing").screenshot({ path: testInfo.outputPath("tp17221-updated.png") });
  });
}
