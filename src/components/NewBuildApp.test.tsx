import type { ComponentProps } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfUpload } from "./newbuild/PdfUpload";
import type { PaintBucketCanvas } from "./newbuild/PaintBucketCanvas";
import type { RoiReviewCanvas } from "./newbuild/RoiReviewCanvas";
import type { NewBuildOutletCanvas } from "./newbuild/NewBuildOutletCanvas";
import type { RoofIllustrationCanvas } from "./newbuild/RoofIllustrationCanvas";
import type { ProjectDetailsForm } from "./ProjectDetailsForm";
import { NewBuildApp } from "./NewBuildApp";
import { syntheticAnnotation, syntheticPage, syntheticRun } from "@/test/roi";
import { roiClient } from "@/integrations/roi/client";
import { drawingWithPenetrations } from "@/utils/penetrationOpenings";
import { outlineResponse } from "@/test/outline";

const outline = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }];
const redrawnOutline = [outline[0], outline[1], { x: 380, y: 180 }, { x: 360, y: 240 }, outline[2], outline[3]];
const sameCountRedrawnOutline = [outline[0], { x: 420, y: 90 }, { x: 420, y: 310 }, outline[3]];
const hole = [{ x: 150, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 180 }];
let restoreRedrawHistory: (() => void) | undefined;

vi.mock("./newbuild/PdfUpload", () => ({
  PdfUpload: ({ onPdfRendered, onPageRendered, onPageSelectionStart, onDocumentLoaded, drawingScale, onDrawingScaleChange }: ComponentProps<typeof PdfUpload>) => (
    <>
      <output data-testid="upload-scale">{drawingScale.scaleRatio}</output>
      <button onClick={() => onDrawingScaleChange({ ...drawingScale, scaleRatio: 50 })}>Change upload scale</button>
      {[1, 2].map((factor) => (
        <button key={factor} onClick={() => {
          const canvas = document.createElement("canvas");
          canvas.width = 800 * factor;
          canvas.height = 600 * factor;
          const page = syntheticPage(`page-${factor}`, factor);
          onPageSelectionStart?.();
          onDocumentLoaded?.(page.document_id, new File(["%PDF-1.4"], page.file_name, { type: "application/pdf" }));
          onPageRendered?.(page, canvas);
          onPdfRendered(canvas);
        }}>Render PDF {factor}</button>
      ))}
    </>
  ),
}));

vi.mock("./newbuild/PaintBucketCanvas", () => ({
  PaintBucketCanvas: ({ onOutlinesExtracted, onHolesExtracted, roofOutlines, interiorHoles, penetrationHoles, acceptedRegions, captureDrawingHistory,
    outlineGeneration, unoutlinedRegions }: ComponentProps<typeof PaintBucketCanvas>) => (
    <>
      <output data-testid="paint-outlines">{JSON.stringify(roofOutlines)}</output>
      <output data-testid="paint-regions">{JSON.stringify(acceptedRegions)}</output>
      <output data-testid="paint-holes">{JSON.stringify(interiorHoles)}</output>
      <output data-testid="paint-openings">{JSON.stringify(penetrationHoles)}</output>
      <output data-testid="paint-outline-generation">{outlineGeneration ?? "idle"}</output>
      <output data-testid="paint-unoutlined">{JSON.stringify(unoutlinedRegions?.map(region => region.box_2d) ?? [])}</output>
      <button onClick={() => onOutlinesExtracted([outline.slice(0, 2)])}>Select invalid outline</button>
      <button onClick={() => onOutlinesExtracted([outline])}>Select roof</button>
      <button onClick={() => {
        restoreRedrawHistory = captureDrawingHistory?.();
        onOutlinesExtracted([redrawnOutline], 0, [[0], [], [4], [5]]);
      }}>Redraw roof side</button>
      <button onClick={() => {
        restoreRedrawHistory = captureDrawingHistory?.();
        onOutlinesExtracted([sameCountRedrawnOutline], 0, [[], [], [], [3]]);
      }}>Redraw roof side without changing count</button>
      <button onClick={() => restoreRedrawHistory?.()}>Undo redraw</button>
      <button onClick={() => onHolesExtracted([hole])}>Add cutout</button>
    </>
  ),
}));

vi.mock("./newbuild/RoiReviewCanvas", () => ({
  RoiReviewCanvas: ({ annotations, page, onAdd, onEdit, onUndoReview }: ComponentProps<typeof RoiReviewCanvas>) => <>
    <output data-testid="review-regions">{JSON.stringify(annotations)}</output>
    <output data-testid="review-drawing">{JSON.stringify(page && drawingWithPenetrations(page))}</output>
    {onUndoReview && <button disabled={!page?.history.length} onClick={onUndoReview}>Undo review edit</button>}
    <button onClick={() => onAdd([100.25, 200.5, 400.75, 600.5])}>Add test region</button>
    <button onClick={() => onAdd([0, 0, 1000, 1000])}>Add full-page region</button>
    <button onClick={() => onAdd([700, 700, 900, 900])}>Add far test region</button>
    <button onClick={() => onEdit(annotations[0].id, [240, 300, 300, 350])}>Move test penetration</button>
  </>,
}));

vi.mock("./newbuild/NewBuildOutletCanvas", () => ({
  NewBuildOutletCanvas: ({ outlets, interiorHoles, onAddOutlet, onMoveOutlet, onToggleDrainageEdge }: ComponentProps<typeof NewBuildOutletCanvas>) => (
    <>
      <output data-testid="editor-outlets">{JSON.stringify(outlets)}</output>
      <output data-testid="editor-holes">{JSON.stringify(interiorHoles)}</output>
      <button onClick={() => onAddOutlet(200, 200)}>Add test outlet</button>
      <button onClick={() => onMoveOutlet(outlets[0].id, 220, 240)}>Move test outlet</button>
      <button onClick={() => onToggleDrainageEdge(0, 1)}>Toggle drainage</button>
      <button onClick={() => onToggleDrainageEdge(0, 3)}>Toggle closing drainage</button>
    </>
  ),
}));

vi.mock("./newbuild/NewBuildSidebar", () => ({ NewBuildSidebar: () => null }));

vi.mock("./newbuild/RoofIllustrationCanvas", () => ({
  RoofIllustrationCanvas: ({ roofOutlines, outlineGroups, interiorHoles, outlets, drainageEdges, mmPerPixel, onMoveGroup, onResetLayout }: ComponentProps<typeof RoofIllustrationCanvas>) => (
    <>
      <output data-testid="illustration">{JSON.stringify({ roofOutlines, interiorHoles, outlets, drainageEdges })}</output>
      <output data-testid="illustration-mm-per-pixel">{mmPerPixel}</output>
      {onMoveGroup && <button onClick={() => onMoveGroup(outlineGroups![1], { x: 20.5, y: 0 })}>Move illustration</button>}
      {onMoveGroup && <button disabled={!onResetLayout} onClick={onResetLayout}>Reset layout</button>}
    </>
  ),
}));

vi.mock("./ProjectDetailsForm", () => ({
  ProjectDetailsForm: ({ projectDetails, onProjectDetailsChange, penetrations, actions }: ComponentProps<typeof ProjectDetailsForm>) => (
    <>
      <h2>Project details form</h2>
      <label>Project name<input value={projectDetails.projectName} onChange={(event) => onProjectDetailsChange({ ...projectDetails, projectName: event.target.value })} /></label>
      <output data-testid="penetrations">{JSON.stringify(penetrations)}</output>
      {actions}
    </>
  ),
}));

beforeEach(() => {
  roiClient.enabled = false;
  restoreRedrawHistory = undefined;
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA==");
});

async function reviewedPenetrations() {
  roiClient.enabled = true;
  vi.spyOn(roiClient, "uploadPage").mockResolvedValue({ page: {
    ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 400, 300],
  }, upload_id: "upload", expires_in_seconds: 900 });
  vi.spyOn(roiClient, "detect").mockImplementation(async (request, options) => ({
    schema_version: "1", ...request, status: "complete", model: "gemini-3.7-flash", prompt_version: "penetration-v1",
    annotations: [250, 300, 350, 400].map((left, index) => syntheticAnnotation(`child-${index + 1}`, {
      label: `Opening ${index + 1}`, kind: "penetration", subtype: "rooflight", roi_id: options!.acceptedRois![0].id,
      review_status: "suggested", box_2d: [220, left, 250, left + 25], proposed_box_2d: [220, left, 250, left + 25],
    })), warnings: [], run: { ...syntheticRun(request), cached: false, provider_attempts: 1 },
  }));
  const user = userEvent.setup();
  render(<NewBuildApp />);
  const next = () => user.click(screen.getByRole("button", { name: "Next" }));
  const previous = () => user.click(screen.getByRole("button", { name: "Previous" }));
  const penetration = (number: number) => within(screen.getByRole("list", { name: "Penetrations" }))
    .getByRole("button", { name: new RegExp(`^Penetration ${number} `) });
  await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
  await next();
  await user.click(screen.getByRole("button", { name: "Add test region" }));
  await user.click(screen.getByRole("button", { name: "Set Outlines" }));
  await user.click(screen.getByRole("button", { name: "Select roof" }));
  await next();
  await user.click(screen.getByRole("button", { name: "Detect penetrations" }));
  await screen.findByRole("button", { name: /^Penetration 4 suggested/ });
  for (const number of [1, 2]) {
    await user.click(penetration(number));
    await user.click(screen.getByRole("button", { name: "Add opening" }));
  }
  await user.click(penetration(3));
  await user.click(screen.getByRole("button", { name: "Reject" }));
  return { user, next, previous, penetration };
}

describe("manual New Build state", () => {
  it("keeps confirmed openings through an unchanged outline visit without warning about suggestions or rejected entries", async () => {
    const { next, previous } = await reviewedPenetrations();
    await previous();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await next();
    await next();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("editor-holes").textContent!)).toHaveLength(2);
    await next();
    expect(JSON.parse(screen.getByTestId("penetrations").textContent!)).toHaveLength(2);
  });

  it("warns after outline corrections, focuses each opening for confirmation, and proceeds once all are current", async () => {
    const { user, next, previous, penetration } = await reviewedPenetrations();
    await previous();
    await user.click(screen.getByRole("button", { name: "Redraw roof side" }));
    await next();
    await next();
    let warning = screen.getByRole("alertdialog", { name: "Accepted openings need confirmation" });
    expect(warning).toHaveTextContent("2 previously accepted openings need confirmation.");
    expect(warning).toHaveTextContent("excluded from the final drawing and export");
    await user.click(within(warning).getByRole("button", { name: "Review openings" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(penetration(1)).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Confirm opening" }));
    await next();
    warning = screen.getByRole("alertdialog", { name: "Accepted openings need confirmation" });
    expect(warning).toHaveTextContent("1 previously accepted opening needs confirmation.");
    await user.click(within(warning).getByRole("button", { name: "Review openings" }));
    expect(penetration(2)).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Confirm opening" }));
    await next();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(JSON.parse(screen.getByTestId("editor-holes").textContent!)).toHaveLength(2);
    await next();
    expect(JSON.parse(screen.getByTestId("penetrations").textContent!)).toHaveLength(2);
  });

  it("allows explicit continuation without confirming stale openings and warns again on a later review visit", async () => {
    const { user, next, previous } = await reviewedPenetrations();
    await previous();
    await user.click(screen.getByRole("button", { name: "Redraw roof side" }));
    await next();
    await next();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Penetrations" })).toBeVisible();
    await next();
    const warning = screen.getByRole("alertdialog", { name: "Accepted openings need confirmation" });
    await user.click(within(warning).getByRole("button", { name: "Continue without these openings" }));
    expect(JSON.parse(screen.getByTestId("editor-holes").textContent!)).toEqual([]);
    await next();
    expect(JSON.parse(screen.getByTestId("penetrations").textContent!)).toEqual([]);
    expect(screen.getByRole("region", { name: "Penetration annotation summary" })).toHaveTextContent("accepted / Needs review");
    await previous();
    await previous();
    await next();
    expect(screen.getByRole("alertdialog", { name: "Accepted openings need confirmation" }))
      .toHaveTextContent("2 previously accepted openings need confirmation.");
  });

  it("routes additional pages through ROI review and keeps each page's regions separate from manual geometry", async () => {
    roiClient.enabled = true;
    const upload = vi.spyOn(roiClient, "uploadPage");
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));
    const previous = () => user.click(screen.getByRole("button", { name: "Previous" }));
    const paint = () => user.click(screen.getByRole("button", { name: "Set Outlines" }));
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    expect(screen.getByRole("heading", { name: "Roof Areas" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add test region" }));
    const firstRegions = screen.getByTestId("review-regions").textContent!;
    await paint();
    expect(screen.getByTestId("paint-regions").textContent).toBe(firstRegions);
    expect(screen.getByTestId("paint-outlines")).toHaveTextContent("[]");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Select roof" }));
    await next();
    expect(screen.getByRole("heading", { name: "Penetrations" })).toBeInTheDocument();
    await next();
    await user.click(screen.getByRole("button", { name: "Add test outlet" }));
    await user.click(screen.getByRole("button", { name: "Upload Another PDF" }));
    await user.click(screen.getByRole("button", { name: "Render PDF 2" }));
    await next();
    expect(screen.getByTestId("review-regions")).toHaveTextContent("[]");
    await user.click(screen.getByRole("button", { name: "Add test region" }));
    await paint();
    expect(screen.getByTestId("paint-regions")).toHaveTextContent("page-2");
    await previous();
    await previous();
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await user.click(screen.getByRole("button", { name: "Change upload scale" }));
    await next();
    expect(screen.getByTestId("review-regions").textContent).toBe(firstRegions);
    await paint();
    expect(screen.getByTestId("paint-regions").textContent).toBe(firstRegions);
    expect(JSON.parse(screen.getByTestId("paint-outlines").textContent!)).toEqual([outline]);
    await next();
    await next();
    expect(screen.getByTestId("editor-outlets")).toHaveTextContent("page-1");
    expect(upload).not.toHaveBeenCalled();
  });

  it("outlines accepted roof areas one after another and warns before leaving one without an outline", async () => {
    roiClient.enabled = true;
    vi.spyOn(roiClient, "uploadPage").mockResolvedValue({ page: {
      ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 400, 300],
    }, upload_id: "upload", expires_in_seconds: 900 });
    const generate = vi.spyOn(roiClient, "generateOutline").mockImplementation(async (request) => {
      const [top, left, bottom, right] = request.roi.box_2d;
      return outlineResponse(request, [{ x: left * 0.8 + 10, y: top * 0.6 + 10 }, { x: right * 0.8 - 10, y: top * 0.6 + 10 },
        { x: right * 0.8 - 10, y: bottom * 0.6 - 10 }, { x: left * 0.8 + 10, y: bottom * 0.6 - 10 }]);
    });
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));
    const target = () => screen.getByRole("combobox", { name: "Select roof area to outline" });
    const progress = () => screen.getByTestId("outline-progress");
    const generateAndUse = async (label: string) => {
      await user.click(screen.getByRole("button", { name: `Generate ${label} outline` }));
      await user.click(await screen.findByRole("button", { name: "Use outline" }));
    };
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Add test region" }));
    await user.click(screen.getByRole("button", { name: "Add far test region" }));
    await user.click(screen.getByRole("button", { name: "Set Outlines" }));
    // The area chosen in Step 2 is kept while it still needs an outline.
    expect(target()).toHaveDisplayValue("Roof area 2");
    expect(progress()).toHaveTextContent("0 of 2 roof areas outlined. Still to outline: Roof area 1, Roof area 2.");

    await generateAndUse("Roof area 2");
    expect(target()).toHaveDisplayValue("Roof area 1");
    expect(screen.getByText("Roof area 2 outline applied. Roof area 1 is selected next.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Roof area 2 (outlined)" })).toBeInTheDocument();
    expect(progress()).toHaveTextContent("1 of 2 roof areas outlined. Still to outline: Roof area 1.");

    await user.click(screen.getByRole("button", { name: "Undo generated outline" }));
    expect(target()).toHaveDisplayValue("Roof area 2");
    expect(progress()).toHaveTextContent("0 of 2 roof areas outlined.");
    await generateAndUse("Roof area 2");
    expect(target()).toHaveDisplayValue("Roof area 1");

    await next();
    const warning = screen.getByRole("alertdialog");
    expect(warning).toHaveTextContent("Roof area 1 has no outline yet.");
    await user.click(within(warning).getByRole("button", { name: "Outline Roof area 1" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(target()).toHaveDisplayValue("Roof area 1");
    await next();
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Continue anyway" }));
    expect(screen.getByRole("heading", { name: "Penetrations" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(target()).toHaveDisplayValue("Roof area 1");

    await generateAndUse("Roof area 1");
    expect(screen.getByText("Roof area 1 outline applied. Use the existing tools for any further adjustments.")).toBeInTheDocument();
    expect(progress()).toHaveTextContent("2 of 2 roof areas outlined.");
    await next();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Penetrations" })).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls.map(([request]) => request.roi.box_2d)).toEqual([
      [700, 700, 900, 900], [700, 700, 900, 900], [100.25, 200.5, 400.75, 600.5]]);
  });

  it("carries editable penetration openings through the roof mask, outlet view and project payload", async () => {
    roiClient.enabled = true;
    vi.spyOn(roiClient, "uploadPage").mockResolvedValue({ page: {
      ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 400, 300],
    }, upload_id: "upload", expires_in_seconds: 900 });
    vi.spyOn(roiClient, "detect").mockImplementation(async (request, options) => ({
      schema_version: "1", ...request, status: "complete", model: "gemini-3.7-flash", prompt_version: "penetration-v1",
      annotations: [syntheticAnnotation("child", { label: "Rooflight A", kind: "penetration", subtype: "rooflight",
        roi_id: options!.acceptedRois![0].id, review_status: "suggested", box_2d: [220, 250, 250, 280],
        proposed_box_2d: [220, 250, 250, 280] })], warnings: [],
      run: { ...syntheticRun(request), cached: false, provider_attempts: 1 },
    }));
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));
    const previous = () => user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Add test region" }));
    await user.click(screen.getByRole("button", { name: "Set Outlines" }));
    await user.click(screen.getByRole("button", { name: "Select roof" }));
    await user.click(screen.getByRole("button", { name: "Add cutout" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Detect penetrations" }));
    await user.click(await screen.findByRole("button", { name: /Penetration 1 suggested/ }));
    expect(screen.getByRole("button", { name: "Add opening" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add opening" }));
    expect(screen.getByRole("button", { name: "Opening added" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move test penetration" }));
    const opening = [{ x: 240, y: 144 }, { x: 280, y: 144 }, { x: 280, y: 180 }, { x: 240, y: 180 }];
    expect(JSON.parse(screen.getByTestId("review-drawing").textContent!).holes[1].points).toEqual(opening);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(JSON.parse(screen.getByTestId("review-drawing").textContent!).holes).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Undo review edit" }));
    expect(JSON.parse(screen.getByTestId("review-drawing").textContent!).holes[1].points).toEqual(opening);
    await previous();
    expect(JSON.parse(screen.getByTestId("paint-openings").textContent!)).toEqual([opening]);
    expect(JSON.parse(screen.getByTestId("paint-holes").textContent!)).toEqual([hole]);
    await next();
    await next();
    expect(screen.getByTestId("editor-outlets")).toHaveTextContent("[]");
    expect(JSON.parse(screen.getByTestId("editor-holes").textContent!)).toEqual([hole, opening]);
    await next();
    expect(screen.getByRole("region", { name: "Penetration annotation summary" })).toHaveTextContent("Rooflight A");
    expect(screen.getByRole("region", { name: "Penetration annotation summary" })).toHaveTextContent("accepted / Current");
    expect(JSON.parse(screen.getByTestId("penetrations").textContent!)).toEqual([
      expect.objectContaining({ x: 260, y: 162, polygonPoints: opening }),
    ]);
    expect(JSON.parse(screen.getByTestId("illustration").textContent!)).toMatchObject({ roofOutlines: [outline], interiorHoles: [hole, opening] });
    await previous();
    await previous();
    expect(JSON.parse(screen.getByTestId("review-regions").textContent!)[0]).toMatchObject({ id: "child", review_status: "accepted", validity: "current" });
    await previous();
    await previous();
    await user.clear(screen.getByRole("textbox", { name: "Region label" }));
    await user.type(screen.getByRole("textbox", { name: "Region label" }), "Revised roof");
    await user.click(screen.getByRole("button", { name: "Apply correction" }));
    await user.click(screen.getByRole("button", { name: "Set Outlines" }));
    await next();
    expect(JSON.parse(screen.getByTestId("review-regions").textContent!)[0]).toMatchObject({ id: "child", review_status: "accepted", validity: "needs_review" });
  });

  it("requires a rendered PDF and a polygon, then preserves manual work through navigation", async () => {
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const next = () => screen.getByRole("button", { name: "Next" });
    const previous = () => screen.getByRole("button", { name: "Previous" });

    expect(previous()).toBeDisabled();
    expect(next()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    expect(screen.getByRole("img", { name: "PDF Preview" })).toBeInTheDocument();
    await user.click(next());
    expect(next()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Select invalid outline" }));
    expect(next()).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Select roof" }));
    await user.click(screen.getByRole("button", { name: "Add cutout" }));
    await user.click(next());
    await user.click(screen.getByRole("button", { name: "Add test outlet" }));
    await user.click(screen.getByRole("button", { name: "Move test outlet" }));
    await user.click(screen.getByRole("button", { name: "Toggle drainage" }));
    await user.click(previous());
    expect(JSON.parse(screen.getByTestId("paint-outlines").textContent!)).toEqual([outline]);
    await user.click(next());
    expect(JSON.parse(screen.getByTestId("editor-outlets").textContent!)).toEqual([
      expect.objectContaining({ x: 220, y: 240, diameter: 0.12 }),
    ]);
    await user.click(next());
    expect(JSON.parse(screen.getByTestId("illustration").textContent!)).toEqual({
      roofOutlines: [outline], interiorHoles: [hole],
      outlets: [expect.objectContaining({ x: 220, y: 240, diameter: 0.12 })],
      drainageEdges: [{ outlineIndex: 0, edgeIndex: 1 }],
    });
    // A 800 px page at the default A1 1:100 upload scale: outlets are drawn at their diameter.
    expect(screen.getByTestId("illustration-mm-per-pixel")).toHaveTextContent("105.125");
    expect(screen.queryByRole("button", { name: "Move illustration" })).not.toBeInTheDocument();
    expect(screen.getByTestId("penetrations")).toHaveTextContent("[]");
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Manual baseline");
    await user.click(previous());
    await user.click(next());
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Manual baseline");
    expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled();
    expect(screen.getByLabelText("Performance specification PDF")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Package contents" })).toHaveTextContent("page-1.pdf");
    expect(screen.getByRole("button", { name: "Download package (.zip)" })).toBeEnabled();
  });

  it.each([
    { button: "Redraw roof side", points: redrawnOutline, closingEdge: 5 },
    { button: "Redraw roof side without changing count", points: sameCountRedrawnOutline, closingEdge: 3 },
  ])("remaps only retained drainage and restores the full drawing after $button", async ({ button, points, closingEdge }) => {
    roiClient.enabled = true;
    vi.spyOn(roiClient, "uploadPage").mockResolvedValue({ page: {
      ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 400, 300],
    }, upload_id: "upload", expires_in_seconds: 900 });
    vi.spyOn(roiClient, "generateOutline").mockImplementation(async request => outlineResponse(request, outline));
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));
    const previous = () => user.click(screen.getByRole("button", { name: "Previous" }));
    const drawing = () => JSON.parse(screen.getByTestId("review-drawing").textContent!);

    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Add full-page region" }));
    await user.click(screen.getByRole("button", { name: "Set Outlines" }));
    await user.click(screen.getByRole("button", { name: "Generate Roof area 1 outline" }));
    await user.click(await screen.findByRole("button", { name: "Use outline" }));
    await user.click(screen.getByRole("button", { name: "Add cutout" }));
    await next();
    await next();
    await user.click(screen.getByRole("button", { name: "Add test outlet" }));
    await user.click(screen.getByRole("button", { name: "Toggle drainage" }));
    await user.click(screen.getByRole("button", { name: "Toggle closing drainage" }));
    await previous();
    const original = drawing();
    const outlineId = original.outlines[0].id;
    expect(original.outlines[0].roi_id).toEqual(expect.any(String));
    expect(original.outlets[0].outline_id).toBe(outlineId);
    expect(original.drainage_edges).toEqual([1, 3].map(edge_index => ({ outline_id: outlineId, edge_index })));

    await previous();
    await user.click(screen.getByRole("button", { name: button }));
    await next();
    const edited = drawing();
    expect(edited.outlines[0]).toEqual({ ...original.outlines[0], points });
    expect(edited.drainage_edges).toEqual([{ outline_id: outlineId, edge_index: closingEdge }]);
    expect(edited.outlets).toEqual(original.outlets);
    expect(edited.holes).toEqual(original.holes);

    await previous();
    await user.click(screen.getByRole("button", { name: "Undo redraw" }));
    await next();
    expect(drawing()).toEqual(original);
  });

  it("tells the editor while outline generation runs or awaits review, and which roof areas still need outlines", async () => {
    roiClient.enabled = true;
    vi.spyOn(roiClient, "uploadPage").mockResolvedValue({ page: {
      ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 400, 300],
    }, upload_id: "upload", expires_in_seconds: 900 });
    let release: (() => void) | undefined;
    vi.spyOn(roiClient, "generateOutline").mockImplementation(async (request) => {
      await new Promise<void>(resolve => { release = resolve; });
      const [top, left, bottom, right] = request.roi.box_2d;
      return outlineResponse(request, [{ x: left * 0.8 + 10, y: top * 0.6 + 10 }, { x: right * 0.8 - 10, y: top * 0.6 + 10 },
        { x: right * 0.8 - 10, y: bottom * 0.6 - 10 }, { x: left * 0.8 + 10, y: bottom * 0.6 - 10 }]);
    });
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const generation = () => screen.getByTestId("paint-outline-generation");
    const unoutlined = () => JSON.parse(screen.getByTestId("paint-unoutlined").textContent!);
    const generate = () => user.click(screen.getByRole("button", { name: "Generate Roof area 2 outline" }));
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Add test region" }));
    await user.click(screen.getByRole("button", { name: "Add far test region" }));
    await user.click(screen.getByRole("button", { name: "Set Outlines" }));
    expect(generation()).toHaveTextContent("idle");
    expect(unoutlined()).toEqual([[100.25, 200.5, 400.75, 600.5], [700, 700, 900, 900]]);

    await generate();
    await waitFor(() => expect(generation()).toHaveTextContent("running"));
    release!();
    await screen.findByRole("button", { name: "Use outline" });
    expect(generation()).toHaveTextContent("review");
    await user.click(screen.getByRole("button", { name: "Discard proposal" }));
    expect(generation()).toHaveTextContent("idle");

    await generate();
    await waitFor(() => expect(generation()).toHaveTextContent("running"));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(generation()).toHaveTextContent("idle");

    await generate();
    await waitFor(() => expect(generation()).toHaveTextContent("running"));
    release!();
    await user.click(await screen.findByRole("button", { name: "Use outline" }));
    expect(generation()).toHaveTextContent("idle");
    expect(unoutlined()).toEqual([[100.25, 200.5, 400.75, 600.5]]);
  });

  it("rescales and offsets an additional PDF once, preserving holes, outlets and drainage indices", async () => {
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));

    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Select roof" }));
    await user.click(screen.getByRole("button", { name: "Add cutout" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Add test outlet" }));
    await user.click(screen.getByRole("button", { name: "Toggle drainage" }));
    await user.click(screen.getByRole("button", { name: "Upload Another PDF" }));
    await user.click(screen.getByRole("button", { name: "Render PDF 2" }));
    await next();
    expect(screen.getByTestId("paint-outlines")).toHaveTextContent("[]");
    await user.click(screen.getByRole("button", { name: "Select roof" }));
    await user.click(screen.getByRole("button", { name: "Add cutout" }));
    await next();
    expect(screen.getByTestId("editor-outlets")).toHaveTextContent("[]");
    await user.click(screen.getByRole("button", { name: "Add test outlet" }));
    await user.click(screen.getByRole("button", { name: "Toggle drainage" }));
    await next();

    const merged = screen.getByTestId("illustration").textContent!;
    expect(JSON.parse(merged)).toEqual({
      roofOutlines: [outline, [{ x: 440, y: 50 }, { x: 590, y: 50 }, { x: 590, y: 150 }, { x: 440, y: 150 }]],
      interiorHoles: [hole, [{ x: 465, y: 75 }, { x: 480, y: 75 }, { x: 480, y: 90 }]],
      outlets: [expect.objectContaining({ x: 200, y: 200 }), expect.objectContaining({ x: 490, y: 100 })],
      drainageEdges: [{ outlineIndex: 0, edgeIndex: 1 }, { outlineIndex: 1, edgeIndex: 1 }],
    });
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(JSON.parse(screen.getByTestId("editor-outlets").textContent!)).toEqual([
      expect.objectContaining({ x: 200, y: 200, page_id: "page-2" }),
    ]);
    await next();
    expect(screen.getByTestId("illustration").textContent).toBe(merged);
    expect(screen.getByRole("button", { name: "Reset layout" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move illustration" }));
    const moved = screen.getByTestId("illustration").textContent!;
    expect(JSON.parse(moved)).toMatchObject({
      roofOutlines: [outline, [{ x: 460.5, y: 50 }, { x: 610.5, y: 50 }, { x: 610.5, y: 150 }, { x: 460.5, y: 150 }]],
      interiorHoles: [hole, [{ x: 485.5, y: 75 }, { x: 500.5, y: 75 }, { x: 500.5, y: 90 }]],
      outlets: [{ x: 200, y: 200 }, { x: 510.5, y: 100 }],
    });
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Previous" }));
    expect(JSON.parse(screen.getByTestId("paint-outlines").textContent!)).toEqual([outline]);
    expect(JSON.parse(screen.getByTestId("paint-holes").textContent!)).toEqual([hole]);
    await user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    expect(JSON.parse(screen.getByTestId("paint-outlines").textContent!)).toEqual([outline]);
    await next();
    expect(JSON.parse(screen.getByTestId("editor-outlets").textContent!)).toEqual([
      expect.objectContaining({ x: 200, y: 200, page_id: "page-1" }),
    ]);
    await next();
    expect(screen.getByTestId("illustration").textContent).toBe(moved);
    await user.click(screen.getByRole("button", { name: "Reset layout" }));
    expect(screen.getByTestId("illustration").textContent).toBe(merged);
    expect(screen.getByRole("button", { name: "Reset layout" })).toBeDisabled();
  });

  it("isolates a new page and restores the previous page when an additional upload is cancelled", async () => {
    const user = userEvent.setup();
    render(<NewBuildApp />);
    const next = () => user.click(screen.getByRole("button", { name: "Next" }));
    const previous = () => user.click(screen.getByRole("button", { name: "Previous" }));
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Select roof" }));
    await user.click(screen.getByRole("button", { name: "Add cutout" }));
    await next();
    await user.click(screen.getByRole("button", { name: "Add test outlet" }));
    await user.click(screen.getByRole("button", { name: "Upload Another PDF" }));
    await user.click(screen.getByRole("button", { name: "Change upload scale" }));
    expect(screen.getByTestId("upload-scale")).toHaveTextContent("50");
    await user.click(screen.getByRole("button", { name: "Render PDF 2" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("editor-outlets")).toHaveTextContent("page-1");
    await previous();
    await previous();
    expect(screen.getByTestId("upload-scale")).toHaveTextContent("100");
    await user.click(screen.getByRole("button", { name: "Render PDF 2" }));
    await next();
    expect(screen.getByTestId("paint-outlines")).toHaveTextContent("[]");
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await previous();
    await user.click(screen.getByRole("button", { name: "Render PDF 1" }));
    await next();
    expect(JSON.parse(screen.getByTestId("paint-outlines").textContent!)).toEqual([outline]);
    expect(JSON.parse(screen.getByTestId("paint-holes").textContent!)).toEqual([hole]);
  });
});
