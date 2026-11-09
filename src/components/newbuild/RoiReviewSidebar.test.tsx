import { useReducer, useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { penetrationSession } from "@/test/penetrations";
import type { RoiAnnotation } from "@/types/roi";
import { initialRoiState, roiSessionReducer } from "@/utils/roiSession";
import { RoiReviewSidebar } from "./RoiReviewSidebar";

describe("ROI failure feedback", () => {
  it.each([false, true])("shows completed detection timing or cached recommendations (cached=%s)", (cached) => {
    const source = syntheticPage();
    const state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    render(<RoiReviewSidebar page={state.pages[source.page_id]} selectedId={null} adding={false}
      onSelect={vi.fn()} onAddingChange={vi.fn()} dispatch={vi.fn()}
      detection={{ busy: false, restarting: false, cancel: vi.fn(), detect: vi.fn(),
        feedback: { status: "complete", durationMs: 12_345, cached, providerAttempts: 1 } }} />);
    expect(screen.getByText(cached ? "Reused previous recommendations." : "Detection completed in 12.3 seconds.")).toBeVisible();
  });

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
      detection={{ busy: false, restarting: false, cancel: vi.fn(), detect: vi.fn(), feedback: undefined }} />);
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
      detection={{ busy: false, restarting: false, cancel: vi.fn(), detect: vi.fn(), feedback: undefined }} />);
    expect(screen.getByRole("button", { name: "Detect penetrations" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add opening" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add opening & next" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Manual penetration" })).toBeEnabled();
  });

  it("explains uncertain types, scope coverage and the missed-penetration follow-up without service codes", async () => {
    const source = syntheticPage();
    let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    state = roiSessionReducer(state, { type: "add", page_id: source.page_id,
      annotation: syntheticAnnotation("uncertain", { kind: "penetration", subtype: "unknown", review_status: "suggested",
        warnings: ["penetration_boundary_ambiguous", "penetration_type_requires_review"] }) });
    const detect = vi.fn();
    const { container } = render(<RoiReviewSidebar kind="penetration" page={state.pages[source.page_id]} selectedId="uncertain" adding={false}
      onSelect={vi.fn()} onAddingChange={vi.fn()} dispatch={vi.fn()}
      detection={{ busy: false, restarting: false, cancel: vi.fn(), detect,
        feedback: { status: "partial", followUpOf: "previous", warnings: ["penetration_coverage_requires_review", "penetration_scope_incomplete",
          "penetration_crop_limit_reached", "penetration_call_budget_reached", "penetration_scan_time_limit_reached",
          "penetration_crop_failed", "penetration_annotation_limit_reached", "possible_truncation"] } }} />);
    expect(screen.getByRole("button", { name: "Add opening" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add opening & next" })).toBeDisabled();
    expect(screen.getByText(/Choose a penetration type before adding this opening/)).toBeVisible();
    expect(screen.getByText("Some roof areas have no insulation outline; only outlined areas were scanned.")).toBeVisible();
    expect(container.textContent).not.toMatch(/penetration_|possible_truncation/);
    await userEvent.setup().click(screen.getByRole("button", { name: "Find missed penetrations" }));
    expect(detect).toHaveBeenCalledWith("previous");
  });

  it.each([
    ["malformed_output", "The model response could not be validated. No new regions were added."],
    ["truncated_output", "The model response ended before valid annotations were complete. No new regions were added."],
    ["call_budget_exceeded", "The model-call budget has been used. Further detection requires an approved budget reset."],
    ["storage_unavailable", "The service is restarting after an update. Try again in a minute."],
    ["penetration_scope_required", "Define the insulation scope in Step 3 before detecting penetrations."],
  ])("explains %s while retaining accepted regions and manual controls", async (code, message) => {
    const source = syntheticPage();
    let state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    state = roiSessionReducer(state, { type: "add", page_id: source.page_id, annotation: syntheticAnnotation() });
    const detect = vi.fn().mockResolvedValue(undefined);
    const onAddingChange = vi.fn();
    render(<RoiReviewSidebar page={state.pages[source.page_id]} selectedId="roi-1" adding={false}
      onSelect={vi.fn()} onAddingChange={onAddingChange} dispatch={vi.fn()}
      detection={{ busy: false, restarting: false, cancel: vi.fn(), detect, feedback: { status: "error", error: code } }} />);
    expect(screen.getByRole("alert")).toHaveTextContent(message);
    expect(screen.getByRole("alert")).toHaveTextContent("Existing work is retained.");
    expect(screen.getByText("accepted / Manual")).toBeVisible();
    expect(screen.queryByText(/No roof areas returned/)).not.toBeInTheDocument();
    expect(detect).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole("button", { name: "Manual region" }));
    expect(onAddingChange).toHaveBeenCalledWith(true);
    expect(detect).not.toHaveBeenCalled();
  });

  it("explains an automatic retry while the service restarts", () => {
    const source = syntheticPage();
    const state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: { paperSize: "A1", scaleRatio: 100 } });
    const detection = { busy: true, restarting: false, cancel: vi.fn(), detect: vi.fn(), feedback: { status: "detecting" as const } };
    const { rerender } = render(<RoiReviewSidebar page={state.pages[source.page_id]} selectedId={null} adding={false}
      onSelect={vi.fn()} onAddingChange={vi.fn()} dispatch={vi.fn()} detection={detection} />);
    expect(screen.getByRole("status")).toHaveTextContent("Detecting roof areas...");
    rerender(<RoiReviewSidebar page={state.pages[source.page_id]} selectedId={null} adding={false}
      onSelect={vi.fn()} onAddingChange={vi.fn()} dispatch={vi.fn()} detection={{ ...detection, restarting: true }} />);
    expect(screen.getByRole("status")).toHaveTextContent("The service is restarting after an update. Retrying automatically...");
    expect(screen.getByRole("button", { name: "Cancel detection" })).toBeEnabled();
  });
});

function penetration(id: string, patch: Partial<RoiAnnotation> = {}): RoiAnnotation {
  return syntheticAnnotation(id, { kind: "penetration", label: id, subtype: "riser", roi_id: "parent",
    review_status: "suggested", box_2d: [250, 350, 400, 450], ...patch });
}

function reviewQueue(annotations: RoiAnnotation[], selectedId = annotations[0]?.id ?? null) {
  const selected = vi.fn();
  const reviewed = vi.fn();
  function Queue() {
    const [state, dispatch] = useReducer(roiSessionReducer, undefined, () => {
      const initial = penetrationSession();
      initial.pages["page-1"].annotations = [
        ...initial.pages["page-1"].annotations.filter(annotation => annotation.kind !== "penetration"), ...annotations,
      ];
      return initial;
    });
    const [current, setCurrent] = useState<string | null>(selectedId);
    return <RoiReviewSidebar kind="penetration" page={state.pages["page-1"]} selectedId={current} adding={false}
      onSelect={id => { selected(id); setCurrent(id); }} onAddingChange={vi.fn()}
      dispatch={action => { reviewed(action); dispatch(action); }}
      detection={{ busy: false, restarting: false, cancel: vi.fn(), detect: vi.fn(), feedback: undefined }} />;
  }
  render(<Queue />);
  const actions = screen.getByRole("region", { name: "Penetration review actions" });
  const list = screen.getByRole("list", { name: "Penetrations" });
  const item = (index: number) => within(list).getByRole("button", { name: new RegExp(`Penetration ${index}\\b`) });
  return { actions, item, selected, reviewed, user: userEvent.setup() };
}

describe("persistent penetration review actions", () => {
  it("keeps review actions outside the scrolling details and adds the selected opening without advancing", async () => {
    const { actions, item, selected, reviewed, user } = reviewQueue([penetration("Lift overrun"), penetration("Vent")]);
    const scroll = screen.getByTestId("penetration-sidebar-scroll");
    expect(scroll).toContainElement(screen.getByRole("list", { name: "Penetrations" }));
    expect(scroll).not.toContainElement(actions);
    expect(actions).toHaveTextContent("Penetration 1");
    expect(actions).toHaveTextContent("Lift overrun");
    await user.click(within(actions).getByRole("button", { name: "Add opening" }));
    expect(reviewed).toHaveBeenLastCalledWith({ type: "review", page_id: "page-1", id: "Lift overrun",
      patch: { review_status: "accepted", validity: "current" } });
    expect(selected).not.toHaveBeenCalled();
    expect(item(1)).toHaveAttribute("aria-pressed", "true");
    expect(item(1)).toHaveTextContent("accepted");
    expect(item(2)).toHaveTextContent("suggested");
    expect(within(actions).getByRole("button", { name: "Opening added" })).toBeDisabled();
  });

  it("accepts only the current opening and advances past reviewed items to a stale accepted opening", async () => {
    const { actions, item, selected, reviewed, user } = reviewQueue([
      penetration("First"), penetration("Already added", { review_status: "accepted" }),
      penetration("Rejected", { review_status: "rejected", validity: "needs_review" }),
      penetration("Needs confirmation", { review_status: "accepted", validity: "needs_review" }), penetration("Last"),
    ]);
    await user.click(within(actions).getByRole("button", { name: "Add opening & next" }));
    expect(selected).toHaveBeenLastCalledWith("Needs confirmation");
    expect(item(1)).toHaveTextContent("accepted");
    expect(item(4)).toHaveAttribute("aria-pressed", "true");
    expect(item(4)).toHaveTextContent("Needs review");
    expect(item(5)).toHaveTextContent("suggested");
    expect(reviewed).toHaveBeenCalledTimes(1);
    expect(actions).toHaveTextContent("Penetration 4");
    expect(actions).toHaveTextContent("Needs confirmation");
    await user.click(within(actions).getByRole("button", { name: "Confirm opening & next" }));
    expect(reviewed).toHaveBeenLastCalledWith({ type: "review", page_id: "page-1", id: "Needs confirmation",
      patch: { review_status: "accepted", validity: "current" } });
    expect(item(4)).not.toHaveTextContent("Needs review");
    expect(item(5)).toHaveAttribute("aria-pressed", "true");
    expect(selected).toHaveBeenLastCalledWith("Last");
    expect(item(5)).toHaveTextContent("suggested");
  });

  it("wraps to an earlier unreviewed opening and stays on the final opening when review is complete", async () => {
    const { actions, item, selected, reviewed, user } = reviewQueue([
      penetration("Earlier"), penetration("Already added", { review_status: "accepted" }),
      penetration("Rejected", { review_status: "rejected" }), penetration("Current"),
    ], "Current");
    await user.click(within(actions).getByRole("button", { name: "Add opening & next" }));
    expect(selected).toHaveBeenCalledExactlyOnceWith("Earlier");
    expect(item(4)).toHaveTextContent("accepted");
    expect(item(1)).toHaveAttribute("aria-pressed", "true");
    expect(item(1)).toHaveTextContent("suggested");
    await user.click(within(actions).getByRole("button", { name: "Add opening & next" }));
    expect(reviewed).toHaveBeenCalledTimes(2);
    expect(selected).toHaveBeenCalledTimes(1);
    expect(item(1)).toHaveAttribute("aria-pressed", "true");
    expect(item(1)).toHaveTextContent("accepted");
    expect(actions).toHaveTextContent("All penetrations reviewed.");
    expect(within(actions).getByRole("button", { name: "Opening added" })).toBeDisabled();
  });

  it("rejects and deletes the selected penetration from the persistent actions", async () => {
    const { actions, item, reviewed, user } = reviewQueue([penetration("First"), penetration("Second")]);
    await user.click(item(2));
    expect(actions).toHaveTextContent("Penetration 2");
    expect(actions).toHaveTextContent("Second");
    await user.click(within(actions).getByRole("button", { name: "Reject" }));
    expect(reviewed).toHaveBeenLastCalledWith({ type: "review", page_id: "page-1", id: "Second",
      patch: { review_status: "rejected", validity: "current" } });
    expect(item(2)).toHaveTextContent("rejected");
    await user.click(within(actions).getByRole("button", { name: "Delete penetration" }));
    expect(reviewed).toHaveBeenLastCalledWith({ type: "remove", page_id: "page-1", id: "Second" });
    expect(screen.getByRole("list", { name: "Penetrations" }).children).toHaveLength(1);
  });

  it("blocks both acceptance actions when the selected boundary is invalid", async () => {
    const { actions, reviewed, selected, user } = reviewQueue([penetration("Crossed", { footprint: [
      { x: 280, y: 150 }, { x: 360, y: 240 }, { x: 360, y: 150 }, { x: 280, y: 240 },
    ] }), penetration("Next")]);
    const add = within(actions).getByRole("button", { name: "Add opening" });
    const advance = within(actions).getByRole("button", { name: "Add opening & next" });
    expect(add).toBeDisabled();
    expect(advance).toBeDisabled();
    await user.click(add);
    await user.click(advance);
    expect(reviewed).not.toHaveBeenCalled();
    expect(selected).not.toHaveBeenCalled();
  });
});
