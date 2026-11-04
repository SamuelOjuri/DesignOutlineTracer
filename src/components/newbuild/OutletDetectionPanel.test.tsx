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
    detection: { generate: vi.fn(async () => undefined), cancel: vi.fn(), busy: false, restarting: false, feedback: null } };
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
    expect(screen.getByRole("alert")).toHaveTextContent("Making the marker smaller will not resolve this warning.");
    expect(screen.getByText(/Its display size is independent of the outlet diameter/)).toBeInTheDocument();
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
    expect(screen.getByText(/120 mm is the application default, not a size measured/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm diameter" }));
    expect(callbacks.dispatch).toHaveBeenCalledWith({ type: "outlet-review", page_id: "page-1", id: "outlet-annotation-1",
      patch: { diameter: 0.12, diameter_confirmed: true } });
    await user.click(screen.getByRole("button", { name: "Add manually" }));
    expect(callbacks.onModeChange).toHaveBeenCalledWith("add-outlets");
  });

  it("offers an explicit symbol-centre correction without accepting or snapping to the perimeter", async () => {
    const user = userEvent.setup();
    const callbacks = props();
    Object.assign(callbacks.page.annotations[1], { subtype: "parapet_outlet", anchor: { x: 199, y: 120 },
      box_2d: [180, 250, 220, 280], warnings: ["outlet_outside_scope",
        "The inlet is outside its insulation scope. Correct its position or association."] });
    render(<OutletDetectionPanel {...callbacks} />);
    expect(screen.getAllByText(/The inlet centre is outside/)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Accept outlet" })).toBeDisabled();
    await user.click(screen.getByText("Correct position, type or size"));
    await user.click(screen.getByRole("button", { name: "Use symbol centre" }));
    expect(callbacks.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "outlet-move", page_id: "page-1",
      id: "outlet-annotation-1", anchor: { x: 212, y: 120 } });
  });

  it("does not offer symbol centring into an excluded opening or outside the roof", () => {
    const callbacks = props();
    callbacks.page.annotations[1].box_2d = [20, 20, 40, 40];
    const { rerender } = render(<OutletDetectionPanel {...callbacks} />);
    expect(screen.queryByRole("button", { name: "Use symbol centre", hidden: true })).not.toBeInTheDocument();
    callbacks.page.annotations[1].box_2d = [180, 250, 220, 280];
    callbacks.page.drawing.holes.push({ id: "hole", page_id: "page-1", roi_id: "roi-1", points: [
      { x: 205, y: 110 }, { x: 220, y: 110 }, { x: 220, y: 130 }, { x: 205, y: 130 },
    ] });
    rerender(<OutletDetectionPanel {...callbacks} />);
    expect(screen.queryByRole("button", { name: "Use symbol centre", hidden: true })).not.toBeInTheDocument();
  });

  it("counts manual outlets alongside detections and shows accepted outlets as accepted", () => {
    const callbacks = props();
    callbacks.page.drawing.outlets.push({ id: "manual-1", page_id: "page-1", x: 400, y: 200, diameter: 0.15, outline_id: "outline-1" });
    const { rerender } = render(<OutletDetectionPanel {...callbacks} />);
    expect(screen.getByText("0 of 1 detected outlet accepted · 1 manual outlet", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept outlet" })).toBeEnabled();
    Object.assign(callbacks.page.annotations[1], { review_status: "accepted", scope_signature: outletScopeSignature(callbacks.page) });
    rerender(<OutletDetectionPanel {...callbacks} />);
    expect(screen.getByText("1 of 1 detected outlet accepted · 1 manual outlet", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept outlet" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accepted" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled();
    callbacks.page.annotations.splice(1, 1);
    rerender(<OutletDetectionPanel {...callbacks} selectedId={null} />);
    expect(screen.getByText("1 manual outlet", { exact: true })).toBeInTheDocument();
  });

  it("explains an automatic retry and a service that is still restarting", () => {
    const callbacks = props();
    callbacks.detection = { ...callbacks.detection, busy: true, restarting: true, feedback: { status: "detecting" } };
    const { rerender } = render(<OutletDetectionPanel {...callbacks} />);
    expect(screen.getByText("The service is restarting after an update. Retrying automatically...")).toBeInTheDocument();
    rerender(<OutletDetectionPanel {...callbacks} detection={{ ...callbacks.detection, busy: false, restarting: false,
      feedback: { status: "error", error: "storage_unavailable" } }} />);
    expect(screen.queryByText(/Retrying automatically/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
      "The service is restarting after an update. Existing outlets are unchanged; try again in a minute.");
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
