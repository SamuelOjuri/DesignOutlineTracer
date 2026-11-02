import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import { emptyProjectDetails } from "@/lib/projectDetailsFields";
import { packagePage, pdfFile } from "@/test/package";
import { readBlobBytes } from "@/utils/roiSource";
import { downloadBlob } from "@/utils/specDocument";
import { PackageDownload } from "./PackageDownload";

vi.mock("@/utils/roofRender", () => ({
  renderDrawingPng: vi.fn(async () => new Blob(["drawing"], { type: "image/png" })),
  renderMaskPng: vi.fn(async () => new Blob(["mask"], { type: "image/png" })),
  renderMarkedUpPagePng: vi.fn(async () => new Blob(["marked"], { type: "image/png" })),
}));

vi.mock("@/utils/specDocument", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/utils/specDocument")>(),
  downloadBlob: vi.fn(),
}));

const page = packagePage();
const roofPlan = pdfFile("251004 WD03 C7.pdf");

describe("PackageDownload", () => {
  it("blocks the download until the roof plan PDF and outline are available", () => {
    render(<PackageDownload projectDetails={emptyProjectDetails()} specDocument={null} roofPlanFiles={{}}
      pages={[page]} illustrationOffsets={{}} />);
    expect(screen.getByRole("button", { name: "Download package (.zip)" })).toBeDisabled();
    expect(screen.getByText("Re-upload the roof plan PDF in Step 1")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No performance specification attached");
  });

  it("downloads a zip containing the separate specification, CSV, roof plan, drawings and prompt", async () => {
    const user = userEvent.setup();
    const spec = pdfFile("spec.pdf", "%PDF-1.4 specification as provided");
    render(<PackageDownload projectDetails={{ ...emptyProjectDetails(), projectName: "Demo" }} specDocument={spec}
      roofPlanFiles={{ [page.source.document_id]: roofPlan }} pages={[page]} illustrationOffsets={{}} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("1 roof area(s), 1 outlet(s)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Download package (.zip)" }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledTimes(1));
    const [blob, fileName] = vi.mocked(downloadBlob).mock.calls[0];
    expect(fileName).toMatch(/^TPID_Demo_\d{8}-\d{4}\.zip$/);
    const files = unzipSync(new Uint8Array(await readBlobBytes(blob)));
    expect(strFromU8(files["1_spec/spec.pdf"])).toBe("%PDF-1.4 specification as provided");
    expect(strFromU8(files["2_details/project_details.csv"])).toContain("projectName,Project Name,Demo");
    expect(files["3_roof_plan/251004 WD03 C7.pdf"]).toBeDefined();
    expect(strFromU8(files["4_drawing/roof_plan_marked_up_p1.png"])).toBe("marked");
    expect(files["5_prompt/TRICS_design_prompt.md"]).toBeDefined();
  });
});
