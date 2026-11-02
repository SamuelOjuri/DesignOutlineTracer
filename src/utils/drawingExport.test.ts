import { describe, expect, it } from "vitest";
import { packagePage } from "@/test/package";
import { syntheticAnnotation } from "@/test/roi";
import { buildRoofExport, maskLayout, roofExportDxf, roofExportGeoJson, roofExportMetadata, roofExportSvg } from "./drawingExport";

describe("roof drawing export", () => {
  it("converts the combined drawing to millimetres with y up from the bottom-left", () => {
    const { model, drawing } = buildRoofExport([packagePage()])!;
    expect(drawing.roofOutlines).toHaveLength(1);
    expect(model).toMatchObject({ units: "mm", axes: "x-right-y-up", width_mm: 30000, height_mm: 20000, mm_per_drawing_unit: 100 });
    expect(model.roof_areas[0]).toMatchObject({ id: "outline-page-1", label: "Roof area 1", page_id: "page-1",
      outline: [{ x: 0, y: 20000 }, { x: 30000, y: 20000 }, { x: 30000, y: 0 }, { x: 0, y: 0 }],
      gross_area_m2: 600, net_area_m2: 591, perimeter_m: 100 });
    expect(model.openings[0]).toMatchObject({ kind: "cutout", label: "Cutout 1", roof_area_id: "outline-page-1", area_m2: 9 });
    expect(model.outlets[0]).toMatchObject({ label: "Outlet 1", position: { x: 10000, y: 10000 }, diameter_mm: 150,
      diameter_confirmed: false, origin: "manual", roof_area_id: "outline-page-1" });
    expect(model.drainage_edges[0]).toMatchObject({ roof_area_id: "outline-page-1", edge_index: 1,
      start: { x: 30000, y: 20000 }, end: { x: 30000, y: 0 }, length_m: 20 });
    expect(model.sources[0]).toMatchObject({ file_name: "page-1.pdf", paper_size: "A1", scale_ratio: 100, mm_per_pixel: 100 });
    expect(model.totals).toEqual({ roof_areas: 1, gross_area_m2: 600, net_area_m2: 591, penetrations: 0, cutouts: 1,
      outlets: 1, unconfirmed_outlet_diameters: 1, drainage_edges: 1 });
    expect(model.notes.join(" ")).toContain("A1 @ 1:100");
    expect(model.notes.join(" ")).toContain("unconfirmed 150 mm");
  });

  it("follows the Project Details layout offsets and notes multi-page arrangement", () => {
    const pages = [packagePage("page-1"), packagePage("page-2")];
    const plain = buildRoofExport(pages)!.model;
    const moved = buildRoofExport(pages, { "outline-page-2": { x: 0, y: 50 } })!.model;
    expect(plain.roof_areas).toHaveLength(2);
    expect(moved.height_mm).toBe(plain.height_mm + 5000);
    expect(moved.notes.join(" ")).toContain("illustrative");
  });

  it("classifies accepted penetration openings separately from manual cutouts", () => {
    const page = packagePage();
    page.drawing.outlines[0].roi_id = "roi";
    page.annotations = [syntheticAnnotation("roi", { box_2d: [0, 0, 1000, 1000], proposed_box_2d: [0, 0, 1000, 1000] }),
      syntheticAnnotation("rooflight", { kind: "penetration", subtype: "rooflight", roi_id: "roi",
        box_2d: [400, 300, 450, 350], proposed_box_2d: [400, 300, 450, 350] })];
    const { model } = buildRoofExport([page])!;
    expect(model.openings.map(opening => opening.kind)).toEqual(["cutout", "penetration"]);
    expect(model.totals).toMatchObject({ penetrations: 1, cutouts: 1 });
    expect(roofExportDxf(model)).toContain("PENETRATIONS");
  });

  it("returns nothing when no roof outline exists", () => {
    const page = packagePage();
    page.drawing.outlines = [];
    expect(buildRoofExport([page])).toBeNull();
  });

  it("writes an R12 DXF with millimetre units, layers and closed outlines", () => {
    const { model } = buildRoofExport([packagePage()])!;
    const dxf = roofExportDxf(model);
    const pairs = dxf.trimEnd().split("\r\n");
    expect(pairs.length % 2).toBe(0);
    const values = pairs.filter((_, index) => index % 2 === 1);
    expect(values.slice(0, 4)).toEqual(["SECTION", "HEADER", "$ACADVER", "AC1009"]);
    expect(dxf).toContain("$INSUNITS\r\n 70\r\n4");
    for (const layer of ["ROOF_OUTLINE", "CUTOUTS", "PENETRATIONS", "DRAINAGE_EDGES", "OUTLETS", "OUTLETS_UNCONFIRMED", "LABELS"]) {
      expect(values).toContain(layer);
    }
    expect(values.filter(value => value === "POLYLINE")).toHaveLength(2);
    expect(values.filter(value => value === "VERTEX")).toHaveLength(8);
    expect(values.filter(value => value === "CIRCLE")).toHaveLength(1);
    expect(values.filter(value => value === "LINE")).toHaveLength(1);
    expect(dxf).toContain("CIRCLE\r\n  8\r\nOUTLETS_UNCONFIRMED\r\n 10\r\n10000\r\n 20\r\n10000\r\n 30\r\n0\r\n 40\r\n75");
    expect(values[values.length - 1]).toBe("EOF");
  });

  it("writes a true-scale SVG and RFC 7946 oriented GeoJSON", () => {
    const { model } = buildRoofExport([packagePage()])!;
    const svg = roofExportSvg(model);
    expect(svg).toContain('width="31800mm" height="21800mm" viewBox="-900 -900 31800 21800"');
    expect(svg).toContain('d="M 0,0 L 30000,0 L 30000,20000 L 0,20000 Z"');
    expect(svg).toContain('<circle cx="10000" cy="10000" r="75" stroke-dasharray=');
    const geojson = JSON.parse(roofExportGeoJson(model));
    expect(geojson.tpid).toMatchObject({ units: "mm", crs: expect.stringContaining("not WGS84") });
    const roof = geojson.features.find((feature: { properties: { kind: string } }) => feature.properties.kind === "roof_area");
    const [outer, hole] = roof.geometry.coordinates as number[][][];
    const area = (ring: number[][]) => ring.slice(0, -1).reduce((sum, [x, y], index) => {
      const [nx, ny] = ring[(index + 1) % (ring.length - 1)];
      return sum + x * ny - nx * y;
    }, 0) / 2;
    expect(outer[0]).toEqual(outer[outer.length - 1]);
    expect(area(outer)).toBeGreaterThan(0);
    expect(area(hole)).toBeLessThan(0);
    expect(geojson.features.map((feature: { properties: { kind: string } }) => feature.properties.kind))
      .toEqual(["roof_area", "cutout", "outlet", "drainage_edge"]);
    expect(JSON.parse(roofExportMetadata(model, "2026-11-02T00:00:00.000Z"))).toMatchObject({
      generated_at: "2026-11-02T00:00:00.000Z", version: "tpid-drawing-v1", totals: { net_area_m2: 591 },
      mask_png: { width_px: 2048, height_px: 1392, margin_mm: 600, top_left_mm: { x: -600, y: 20600 } } });
  });

  it("lays the raster mask out with a margin so the roof boundary is visible", () => {
    const { model } = buildRoofExport([packagePage()])!;
    const layout = maskLayout(model);
    expect(layout.px_per_mm).toBeCloseTo(2048 / 31200);
    const column = (0 - layout.top_left_mm.x) * layout.px_per_mm;
    expect(column).toBeGreaterThan(30);
    expect(column).toBeLessThan(layout.width_px / 2);
  });
});
