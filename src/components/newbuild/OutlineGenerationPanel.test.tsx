import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import type { OutlineResponse } from "@/types/outline";
import type { PageSession } from "@/types/roi";
import { syntheticPage, syntheticAnnotation } from "@/test/roi";
import { OutlineGenerationPanel, type OutlineGenerationPanelProps } from "./OutlineGenerationPanel";
import { OutlineProposalOverlay } from "./OutlineProposalOverlay";

const points = [{ x: 200, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }, { x: 200, y: 300 }];
const result: OutlineResponse = {
  schema_version: "outline-1", page_id: "page-1", request_id: "request", source_image_hash: "a".repeat(64),
  roi_revision: 1, geometry_revision: 0, roi_id: "roi-1", roi_annotation_revision: 1, boundary_policy: "inner_parapet",
  status: "needs_review", proposals: [{ id: "proposal", points, proposed_points: points, warnings: [],
    edges: points.map((_, index) => ({ index, source: "vector", support: 1, ambiguous: index === 2 })) }],
  warnings: ["ambiguous_edges"], crop: { x: 100, y: 50, width: 500, height: 400, inference_width: 500, inference_height: 400 },
  run: { model: "gemini-4-argon", prompt_version: "roof-outline-v1", algorithm_version: "test", settings: {},
    duration_ms: 1, cached: false, provider_attempts: 1 },
};

function props(patch: Partial<OutlineGenerationPanelProps> = {}): OutlineGenerationPanelProps {
  const page: PageSession = {
    source: syntheticPage(), annotations: [syntheticAnnotation()], roi_revision: 1, geometry_revision: 0, revision: 0,
    pending: {}, used_request_ids: [], runs: [], history: [],
    drawing: { outlines: [{ id: "manual-1", page_id: "page-1", roi_id: null, points }], holes: [], outlets: [],
      drainage_edges: [], drawing_scale: { paperSize: "A1", scaleRatio: 50 } },
  };
  return { page, regions: page.annotations, roiId: "roi-1", onRoiChange: vi.fn(), policy: "inner_parapet",
    onPolicyChange: vi.fn(), notes: "", onNotesChange: vi.fn(), result: null, busy: false, feedback: null,
    generate: vi.fn(), cancel: vi.fn(), dismiss: vi.fn(), apply: vi.fn(() => null), undo: vi.fn(), canUndo: false,
    onReviewRegion: vi.fn(), ...patch };
}

it("requires an accepted region and only generates from an explicit action with a selectable boundary", async () => {
  const user = userEvent.setup();
  const callbacks = props({ regions: [], roiId: null });
  const { rerender } = render(<OutlineGenerationPanel {...callbacks} />);
  expect(screen.queryByRole("button", { name: "Generate outline" })).not.toBeInTheDocument();
  expect(callbacks.generate).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Review roof areas" }));
  expect(callbacks.onReviewRegion).toHaveBeenCalledOnce();
  rerender(<OutlineGenerationPanel {...callbacks} regions={[syntheticAnnotation()]} roiId="roi-1" />);
  await user.selectOptions(screen.getByLabelText("Boundary to follow"), "roof_deck");
  expect(callbacks.onPolicyChange).toHaveBeenCalledWith("roof_deck");
  await user.click(screen.getByRole("button", { name: "Generate outline" }));
  expect(callbacks.generate).toHaveBeenCalledOnce();
  expect(callbacks.apply).not.toHaveBeenCalled();
});

it("preserves existing outlines by default and passes only explicitly selected replacements", async () => {
  const user = userEvent.setup();
  const callbacks = props({ result, apply: vi.fn(() => "Select the overlapping outline to replace it.") });
  render(<OutlineGenerationPanel {...callbacks} />);
  expect(screen.getByText(/orange dashed edges need review/)).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Use outline" }));
  expect(callbacks.apply).toHaveBeenLastCalledWith([]);
  expect(screen.getByRole("alert")).toHaveTextContent("Select the overlapping outline");
  await user.click(screen.getByRole("checkbox", { name: "Outline 1 (manual)" }));
  await user.click(screen.getByRole("button", { name: "Use outline" }));
  expect(callbacks.apply).toHaveBeenLastCalledWith(["manual-1"]);
});

it("blocks a truncated ROI proposal and allows cancellation and undo without regenerating", async () => {
  const user = userEvent.setup();
  const callbacks = props({ result: { ...result, status: "roi_too_tight" }, busy: true, canUndo: true });
  render(<OutlineGenerationPanel {...callbacks} />);
  expect(screen.queryByRole("button", { name: "Use outline" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Generating outline..." })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  await user.click(screen.getByRole("button", { name: "Undo generated outline" }));
  expect(callbacks.cancel).toHaveBeenCalledOnce();
  expect(callbacks.undo).toHaveBeenCalledOnce();
  expect(callbacks.generate).not.toHaveBeenCalled();
});

it("renders canonical polygon coordinates and differentiates uncertain edges without changing geometry", () => {
  const original = JSON.stringify(result.proposals);
  const { container } = render(<OutlineProposalOverlay proposals={result.proposals} width={800} height={600} />);
  expect(screen.getByRole("img")).toHaveAttribute("viewBox", "0 0 800 600");
  expect(container.querySelector("polygon")).toHaveAttribute("points", "200,100 400,100 400,300 200,300");
  expect(container.querySelectorAll('[data-uncertain="true"]')).toHaveLength(1);
  expect(container.querySelector('[data-outline-edge="2"]')).toHaveAttribute("stroke-dasharray", "7 4");
  expect(JSON.stringify(result.proposals)).toBe(original);
});
