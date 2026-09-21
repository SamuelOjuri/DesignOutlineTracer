import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { initialRoiState, roiSessionReducer } from "@/utils/roiSession";
import { RoiReviewSidebar } from "./RoiReviewSidebar";

describe("ROI failure feedback", () => {
  it("supports penetration correction, parent reassignment and explicit uncertain association review", async () => {
    const source = syntheticPage();
    let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    for (const annotation of [syntheticAnnotation(), syntheticAnnotation("second-roof"),
      syntheticAnnotation("child", { kind: "penetration", subtype: "rooflight", roi_id: "roi-1", review_status: "suggested" })]) {
      state = roiSessionReducer(state, { type: "add", page_id: source.page_id, annotation });
    }
    state = roiSessionReducer(state, { type: "drawing", page_id: source.page_id,
      drawing: { ...state.pages[source.page_id].drawing, outlines: [{ id: "scope", page_id: source.page_id, roi_id: null,
        points: [{ x: 0, y: 0 }, { x: 800, y: 0 }, { x: 800, y: 600 }, { x: 0, y: 600 }] }] } });
    const dispatch = vi.fn();
    render(<RoiReviewSidebar kind="penetration" page={state.pages[source.page_id]} selectedId="child" adding={false}
      onSelect={vi.fn()} onAddingChange={vi.fn()} dispatch={dispatch}
      detection={{ busy: false, cancel: vi.fn(), detect: vi.fn(), feedback: undefined }} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("Edit type, roof area and coordinates"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Parent roof area" }), "second-roof");
    await user.selectOptions(screen.getByRole("combobox", { name: "Subtype" }), "vent");
    await user.clear(screen.getByRole("textbox", { name: "Penetration label" }));
    await user.type(screen.getByRole("textbox", { name: "Penetration label" }), "Reviewed vent");
    await user.click(screen.getByRole("button", { name: "Apply correction" }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "review", page_id: source.page_id, id: "child",
      patch: { label: "Reviewed vent", box_2d: [100, 200, 600, 700], subtype: "vent", roi_id: "second-roof" } });
    await user.click(screen.getByRole("button", { name: "Add opening" }));
    expect(dispatch).toHaveBeenLastCalledWith({ type: "review", page_id: source.page_id, id: "child",
      patch: { review_status: "accepted", validity: "current" } });
  });

  it("keeps manual penetration entry available without allowing detection or acceptance without a parent", () => {
    const source = syntheticPage();
    let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    state = roiSessionReducer(state, { type: "add", page_id: source.page_id,
      annotation: syntheticAnnotation("child", { kind: "penetration", subtype: "vent", review_status: "suggested" }) });
    render(<RoiReviewSidebar kind="penetration" page={state.pages[source.page_id]} selectedId="child" adding={false}
      onSelect={vi.fn()} onAddingChange={vi.fn()} dispatch={vi.fn()}
      detection={{ busy: false, cancel: vi.fn(), detect: vi.fn(), feedback: undefined }} />);
    expect(screen.getByRole("button", { name: "Detect penetrations" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add opening" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Manual penetration" })).toBeEnabled();
  });

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
