import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { outletPage, outletResponse } from "@/test/outlet";
import { outletScopeSignature } from "@/utils/outletScope";
import { OutletDetectionPanel, OutletSummary, type OutletDetectionPanelProps } from "./OutletDetectionPanel";

function props(): OutletDetectionPanelProps {
  const page = outletPage();
  page.annotations.push(outletResponse().annotations[0]);
  return { page, selectedId: "outlet-annotation-1", onSelect: vi.fn(), onModeChange: vi.fn(), dispatch: vi.fn(),
    detection: { generate: vi.fn(async () => undefined), cancel: vi.fn(), busy: false, feedback: null } };
}

describe("outlet review controls", () => {
  it("detects only after an explicit action and keeps acceptance separate", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<OutletDetectionPanel {...callbacks} />);
    expect(callbacks.detection.generate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Detect outlets" }));
    expect(callbacks.detection.generate).toHaveBeenCalledOnce();
    expect(callbacks.onModeChange).toHaveBeenCalledWith("select");
    expect(callbacks.dispatch).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Accept outlet" }));
    expect(callbacks.dispatch).toHaveBeenCalledWith({ type: "outlet-review", page_id: "page-1",
      id: "outlet-annotation-1", patch: { review_status: "accepted" } });
  });

  it("blocks an out-of-scope inlet and explains incomplete detection limits", () => {
    const callbacks = props();
    callbacks.page.annotations[1].anchor = { x: 100, y: 100 };
    callbacks.detection.feedback = { status: "partial", warnings: ["outlet_crop_limit_reached", "outlet_call_budget_reached", "outlet_annotation_limit_reached"] };
    render(<OutletDetectionPanel {...callbacks} />);
    expect(screen.getByRole("button", { name: "Accept outlet" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /Accept eligible/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Only part of the scope was checked/)).toBeInTheDocument();
    expect(screen.getByText(/Detection stopped at the configured call limit/)).toBeInTheDocument();
    expect(screen.getByText(/result reached the outlet limit/)).toBeInTheDocument();
  });

  it("marks size as a default and keeps manual placement available", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    render(<OutletDetectionPanel {...callbacks} />);
    await user.click(screen.getByText("Correct position, type or size"));
    expect(screen.getByText(/150 mm is the application default, not a size measured/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm diameter" }));
    expect(callbacks.dispatch).toHaveBeenCalledWith({ type: "outlet-review", page_id: "page-1", id: "outlet-annotation-1",
      patch: { diameter: 0.15, diameter_confirmed: true } });
    await user.click(screen.getByRole("button", { name: "Add manually" }));
    expect(callbacks.onModeChange).toHaveBeenCalledWith("add-outlets");
  });

  it("excludes stale accepted geometry from the project summary", () => {
    const page = outletPage();
    page.annotations.push({ ...outletResponse().annotations[0], review_status: "accepted", scope_signature: "stale-scope" });
    const { rerender } = render(<OutletSummary pages={[page]} />);
    expect(screen.getByText(/0 accepted detections/)).toBeInTheDocument();
    expect(screen.getByText(/1 unresolved suggestion excluded/)).toBeInTheDocument();
    page.annotations[1].scope_signature = outletScopeSignature(page);
    rerender(<OutletSummary pages={[page]} />);
    expect(screen.getByText(/1 accepted detections/)).toBeInTheDocument();
    expect(screen.queryByText(/unresolved suggestion/)).not.toBeInTheDocument();
    expect(screen.getByText(/1 outlet size uses an unconfirmed application default/)).toBeInTheDocument();
  });
});
