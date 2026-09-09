import { describe, expect, it } from "vitest";
import { BackendProductionSchema } from "./client";
import { backendRasterToCanvasGeometry } from "./coords";

function rasterSchema(): BackendProductionSchema {
  return {
    document: {
      document_id: "document-1", source_file: "roof.pdf",
      source_type: "rasterized_pdf", drawing_type: "roof_plan",
    },
    coordinate_systems: {
      pdf: { units: "pt", page_width: 1000, page_height: 500 },
      cad: { units: "mm", scale: "1:50", calibration_source: "ocr_scale_text", mm_per_pdf_unit: 1 },
    },
    target_area: {
      outer_polygon_mm: [[200, 100], [800, 100], [800, 400], [200, 400]],
      holes: [[[400, 200], [450, 200], [450, 250]]],
      area_m2_estimated: 0.18, confidence: 0.62, review_required: true,
    },
    constraints: {
      rainwater_outlets: [{ id: "rwp1", point_mm: [200, 250], confidence: 0.62 }],
      rooflights: [{ id: "rooflight1", polygon_mm: [[500, 200], [600, 200], [600, 300]], confidence: 0.55 }],
    },
    quality_checks: { human_review_status: "required", polygon_closed: true, self_intersections: false },
  };
}

describe("raster coordinates", () => {
  it("maps page-relative geometry without adding a candidate bbox origin", () => {
    const canvas = { width: 2000, height: 1000 } as HTMLCanvasElement;
    const geometry = backendRasterToCanvasGeometry(rasterSchema(), canvas);

    expect(geometry.outline).toEqual([
      { x: 400, y: 200 }, { x: 1600, y: 200 }, { x: 1600, y: 800 }, { x: 400, y: 800 },
    ]);
    expect(geometry.holes).toEqual([
      [{ x: 800, y: 400 }, { x: 900, y: 400 }, { x: 900, y: 500 }],
      [{ x: 1000, y: 400 }, { x: 1200, y: 400 }, { x: 1200, y: 600 }],
    ]);
    expect(geometry.outlets).toEqual([{ id: "rwp1", x: 400, y: 500, diameter: 0.15 }]);
  });

  it("applies the declared unit conversion and each page dimension", () => {
    const schema = rasterSchema();
    schema.coordinate_systems.cad.mm_per_pdf_unit = 2;
    const geometry = backendRasterToCanvasGeometry(schema, { width: 1000, height: 1000 } as HTMLCanvasElement);
    expect(geometry.outline[0]).toEqual({ x: 100, y: 100 });
    expect(geometry.outlets[0]).toMatchObject({ x: 100, y: 250 });
  });

  it("rejects invalid raster dimensions", () => {
    const schema = rasterSchema();
    schema.coordinate_systems.pdf.page_width = 0;
    expect(() => backendRasterToCanvasGeometry(schema, { width: 1000, height: 500 } as HTMLCanvasElement))
      .toThrow("invalid coordinate dimensions");
  });
});