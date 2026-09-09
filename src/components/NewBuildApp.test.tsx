import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfUpload } from "./newbuild/PdfUpload";
import type { PaintBucketCanvas } from "./newbuild/PaintBucketCanvas";
import type { NewBuildOutletCanvas } from "./newbuild/NewBuildOutletCanvas";
import type { RoofIllustrationCanvas } from "./newbuild/RoofIllustrationCanvas";
import type { ProjectDetailsForm } from "./ProjectDetailsForm";
import { NewBuildApp } from "./NewBuildApp";

const outline = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }];
const hole = [{ x: 150, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 180 }];

vi.mock("./newbuild/PdfUpload", () => ({
  PdfUpload: ({ onPdfRendered }: ComponentProps<typeof PdfUpload>) => (
    <>
      {[1, 2].map((factor) => (
        <button key={factor} onClick={() => {
          const canvas = document.createElement("canvas");
          canvas.width = 800 * factor;
          canvas.height = 600 * factor;
          onPdfRendered(canvas);
        }}>Render PDF {factor}</button>
      ))}
    </>
  ),
}));

vi.mock("./newbuild/PaintBucketCanvas", () => ({
  PaintBucketCanvas: ({ onOutlinesExtracted, onHolesExtracted, roofOutlines }: ComponentProps<typeof PaintBucketCanvas>) => (
    <>
      <output data-testid="paint-outlines">{JSON.stringify(roofOutlines)}</output>
      <button onClick={() => onOutlinesExtracted([outline.slice(0, 2)])}>Select invalid outline</button>
      <button onClick={() => onOutlinesExtracted([outline])}>Select roof</button>
      <button onClick={() => onHolesExtracted([hole])}>Add cutout</button>
    </>
  ),
}));

vi.mock("./newbuild/NewBuildOutletCanvas", () => ({
  NewBuildOutletCanvas: ({ outlets, onAddOutlet, onMoveOutlet, onToggleDrainageEdge }: ComponentProps<typeof NewBuildOutletCanvas>) => (
    <>
      <output data-testid="editor-outlets">{JSON.stringify(outlets)}</output>
      <button onClick={() => onAddOutlet(200, 200)}>Add test outlet</button>
      <button onClick={() => onMoveOutlet(outlets[0].id, 220, 240)}>Move test outlet</button>
      <button onClick={() => onToggleDrainageEdge(0, 1)}>Toggle drainage</button>
    </>
  ),
}));

vi.mock("./newbuild/NewBuildSidebar", () => ({ NewBuildSidebar: () => null }));

vi.mock("./newbuild/RoofIllustrationCanvas", () => ({
  RoofIllustrationCanvas: ({ roofOutlines, interiorHoles, outlets, drainageEdges }: ComponentProps<typeof RoofIllustrationCanvas>) => (
    <output data-testid="illustration">{JSON.stringify({ roofOutlines, interiorHoles, outlets, drainageEdges })}</output>
  ),
}));

vi.mock("./ProjectDetailsForm", () => ({
  ProjectDetailsForm: ({ projectDetails, onProjectDetailsChange, penetrations }: ComponentProps<typeof ProjectDetailsForm>) => (
    <>
      <h2>Project details form</h2>
      <label>Project name<input value={projectDetails.projectName} onChange={(event) => onProjectDetailsChange({ ...projectDetails, projectName: event.target.value })} /></label>
      <output data-testid="penetrations">{JSON.stringify(penetrations)}</output>
    </>
  ),
}));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,AA==");
});

describe("manual New Build state", () => {
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
      expect.objectContaining({ x: 220, y: 240, diameter: 0.15 }),
    ]);
    await user.click(next());
    expect(JSON.parse(screen.getByTestId("illustration").textContent!)).toEqual({
      roofOutlines: [outline], interiorHoles: [hole],
      outlets: [expect.objectContaining({ x: 220, y: 240, diameter: 0.15 })],
      drainageEdges: [{ outlineIndex: 0, edgeIndex: 1 }],
    });
    expect(screen.getByTestId("penetrations")).toHaveTextContent("[]");
    await user.type(screen.getByRole("textbox", { name: "Project name" }), "Manual baseline");
    await user.click(previous());
    await user.click(next());
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue("Manual baseline");
    expect(screen.getByRole("button", { name: "Complete" })).toBeDisabled();
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
    await next();
    expect(screen.getByTestId("illustration").textContent).toBe(merged);
  });
});