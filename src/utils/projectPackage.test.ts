import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { emptyProjectDetails } from "@/lib/projectDetailsFields";
import { packagePage, pdfFile } from "@/test/package";
import { buildRoofExport } from "./drawingExport";
import { buildProjectPackage, packageFileName, safeFileName, type PackageInput } from "./projectPackage";
import { readBlobBytes, sha256 } from "./roiSource";

const SPEC_NAME = "Project_Performance_Specification_Details_3320074395_10523ae8.pdf";
const SPEC_BODY = "%PDF-1.4\nTarget U Value: 0.25\nDecking: Timber (18mm)\n%%EOF\n";

function input(patch: Partial<PackageInput> = {}): PackageInput {
  const page = packagePage();
  return {
    projectDetails: { ...emptyProjectDetails(), name: "Sam", projectName: "Third floor / terrace", fallType: "1:80",
      maxInsulationHeight: "200mm" },
    specDocument: pdfFile(SPEC_NAME, SPEC_BODY),
    roofPlans: [pdfFile("251004 WD03 C7.pdf")],
    model: buildRoofExport([page])!.model,
    drawingPng: new Blob(["drawing-png"], { type: "image/png" }),
    maskPng: new Blob(["mask-png"], { type: "image/png" }),
    markedUpPages: [{ document_id: page.source.document_id, page_id: page.source.page_id, page_index: 2,
      blob: new Blob(["marked-up-png"], { type: "image/png" }) }],
    generatedAt: new Date(2026, 10, 2, 9, 5),
    ...patch,
  };
}

async function unzip(blob: Blob) {
  return unzipSync(new Uint8Array(await readBlobBytes(blob)));
}

describe("project package", () => {
  it("packages every deliverable with a verifiable manifest", async () => {
    const result = await buildProjectPackage(input());
    expect(result.fileName).toBe("TPID_Third_floor_terrace_20261102-0905.zip");
    const files = await unzip(result.blob);
    expect(Object.keys(files).sort()).toEqual([
      `1_spec/${SPEC_NAME}`,
      "2_details/project_details.csv",
      "3_roof_plan/251004 WD03 C7.pdf",
      "4_drawing/roof_drawing.png",
      "4_drawing/roof_mask.png",
      "4_drawing/roof_metadata.json",
      "4_drawing/roof_outline.dxf",
      "4_drawing/roof_outline.geojson",
      "4_drawing/roof_outline.svg",
      "4_drawing/roof_plan_marked_up_p3.png",
      "5_prompt/TRICS_design_prompt.md",
      "manifest.json",
    ]);
    const manifest = JSON.parse(strFromU8(files["manifest.json"]));
    expect(manifest).toMatchObject({ package_version: "tpid-package-v1", performance_specification_supplied: true,
      prompt_template_version: "trics-prompt-v2", drawing_export_version: "tpid-drawing-v1" });
    expect(manifest.files).toHaveLength(11);
    for (const file of manifest.files) {
      expect(files[file.path].byteLength).toBe(file.bytes);
      expect(await sha256(files[file.path].slice().buffer)).toBe(file.sha256);
    }
    expect(manifest.files.find((file: { role: string }) => file.role === "performance_specification"))
      .toMatchObject({ original_file_name: SPEC_NAME, media_type: "application/pdf" });
    expect(manifest.files.find((file: { role: string }) => file.role === "roof_plan_marked_up"))
      .toMatchObject({ source_page: { page_id: "page-1", page_index: 2 } });
    expect(strFromU8(files["5_prompt/TRICS_design_prompt.md"])).toContain("`1_spec/" + SPEC_NAME + "`");
  });

  it("stores the specification byte-for-byte and keeps the form only in the CSV", async () => {
    const files = await unzip((await buildProjectPackage(input())).blob);
    expect(strFromU8(files[`1_spec/${SPEC_NAME}`])).toBe(SPEC_BODY);
    const csv = strFromU8(files["2_details/project_details.csv"]);
    expect(csv).toContain("fallType,Fall Type,1:80\r\n");
    expect(csv).not.toContain("0.25");
    expect(csv).not.toContain("Timber");
    const prompt = strFromU8(files["5_prompt/TRICS_design_prompt.md"]);
    expect(prompt).not.toContain("200mm");
    expect(prompt).not.toContain("0.25");
    expect(prompt).not.toContain("Third floor");
  });

  it("omits the specification folder when none is attached and keeps duplicate names distinct", async () => {
    const result = await buildProjectPackage(input({ specDocument: null,
      roofPlans: [pdfFile("plan.pdf", "%PDF-1.4 a"), pdfFile("plan.pdf", "%PDF-1.4 b")] }));
    const files = await unzip(result.blob);
    expect(Object.keys(files).some(path => path.startsWith("1_spec/"))).toBe(false);
    expect(strFromU8(files["3_roof_plan/plan.pdf"])).toBe("%PDF-1.4 a");
    expect(strFromU8(files["3_roof_plan/plan (2).pdf"])).toBe("%PDF-1.4 b");
    expect(result.manifest.performance_specification_supplied).toBe(false);
    expect(strFromU8(files["5_prompt/TRICS_design_prompt.md"])).toContain("No performance specification document was supplied");
  });

  it("sanitises file names for zip and Windows paths", () => {
    expect(safeFileName('a/b\\c:d*e?"f<g>h|.pdf', "x.pdf")).toBe("a_b_c_d_e__f_g_h_.pdf");
    expect(safeFileName("   ", "fallback.pdf")).toBe("fallback.pdf");
    expect(safeFileName(`${"n".repeat(300)}.pdf`, "x.pdf")).toHaveLength(180);
    expect(safeFileName(`${"n".repeat(300)}.pdf`, "x.pdf").endsWith(".pdf")).toBe(true);
    expect(packageFileName("", new Date(2026, 0, 3, 4, 5))).toBe("TPID_roof_20260103-0405.zip");
  });
});
