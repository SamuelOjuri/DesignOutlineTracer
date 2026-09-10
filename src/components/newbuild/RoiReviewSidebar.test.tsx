import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { initialRoiState, roiSessionReducer } from "@/utils/roiSession";
import { RoiReviewSidebar } from "./RoiReviewSidebar";

describe("ROI failure feedback", () => {
  it.each([
    ["malformed_output", "The model response could not be validated. No new regions were added."],
    ["truncated_output", "The model response ended before valid annotations were complete. No new regions were added."],
    ["call_budget_exceeded", "The model-call budget has been used. Further detection requires an approved budget reset."],
  ])("explains %s while retaining accepted regions and manual controls", async (code, message) => {
    const source = syntheticPage();
    let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    state = roiSessionReducer(state, { type: "add", page_id: source.page_id, annotation: syntheticAnnotation() });
    const detect = vi.fn().mockResolvedValue(undefined);
    const onAddingChange = vi.fn();
    render(<RoiReviewSidebar page={state.pages[source.page_id]} selectedId="roi-1" adding={false}
      onSelect={vi.fn()} onAddingChange={onAddingChange} dispatch={vi.fn()}
      detection={{ busy: false, cancel: vi.fn(), detect, feedback: { status: "error", error: code } }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("alert")).toHaveTextContent("Existing work is retained.");
    expect(screen.getByText("accepted / Manual")).toBeVisible();
    expect(screen.queryByText(/No roof areas returned/)).not.toBeInTheDocument();
    expect(detect).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Manual region" }));
    expect(onAddingChange).toHaveBeenCalledWith(true);
    expect(detect).not.toHaveBeenCalled();
  });
});