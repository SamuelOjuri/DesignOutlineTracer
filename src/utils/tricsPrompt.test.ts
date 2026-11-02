import { describe, expect, it } from "vitest";
import { packagePage } from "@/test/package";
import { buildRoofExport } from "./drawingExport";
import { buildTricsPrompt, TRICS_PROMPT_VERSION } from "./tricsPrompt";

const paths = {
  specification: "1_spec/Project_Performance_Specification_Details.pdf",
  details: "2_details/project_details.csv",
  roofPlans: ["3_roof_plan/251004 WD03 C7.pdf"],
  dxf: "4_drawing/roof_outline.dxf",
  svg: "4_drawing/roof_outline.svg",
  geojson: "4_drawing/roof_outline.geojson",
  metadata: "4_drawing/roof_metadata.json",
  drawingPng: "4_drawing/roof_drawing.png",
  maskPng: "4_drawing/roof_mask.png",
  markedUp: ["4_drawing/roof_plan_marked_up_p1.png"],
};

describe("TRICS prompt", () => {
  it("references every package file and keeps the specification sources separate", () => {
    const { model } = buildRoofExport([packagePage()])!;
    const prompt = buildTricsPrompt(model, paths, "2026-11-02T00:00:00.000Z");
    expect(prompt).toContain(TRICS_PROMPT_VERSION);
    for (const path of [paths.specification, paths.details, ...paths.roofPlans, paths.dxf, paths.svg, paths.geojson,
      paths.metadata, paths.drawingPng, paths.maskPng, ...paths.markedUp]) expect(prompt).toContain(`\`${path}\``);
    expect(prompt).toContain("The performance specification document is the source for the performance requirements");
    expect(prompt).toContain("Use the fall type given in the project details CSV");
    expect(prompt).not.toMatch(/conflict/i);
    expect(prompt).not.toContain("reconciled");
    expect(prompt).toContain("| Roof area 1 | 600 | 591 | 100 |");
    expect(prompt).toContain("| Outlet 1 | Roof area 1 | 10000 | 10000 | 150 | no (application default) |");
    expect(prompt).toContain("Roof area 1, edge 2: (30000, 20000) to (30000, 0), 20 m.");
    expect(prompt).toContain("unconfirmed 150 mm application default");
  });

  it("states when no specification document was supplied", () => {
    const { model } = buildRoofExport([packagePage()])!;
    const prompt = buildTricsPrompt(model, { ...paths, specification: null }, "2026-11-02T00:00:00.000Z");
    expect(prompt).toContain("No performance specification document was supplied");
    expect(prompt).toContain("are not known");
    expect(prompt).not.toContain("1_spec/");
  });
});
