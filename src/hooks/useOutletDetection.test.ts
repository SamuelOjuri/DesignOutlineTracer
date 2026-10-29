import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { outletPage, outletResponse } from "@/test/outlet";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import type { OutletResponse } from "@/types/outlet";
import { RoiApiError } from "@/integrations/roi/client";
import { useRoiSession } from "./useRoiSession";
import { useOutletDetection, type OutletDetectionClient } from "./useOutletDetection";

function setup(enabled = true) {
  const upload = vi.fn<OutletDetectionClient["uploadPage"]>().mockResolvedValue({});
  const generate = vi.fn<OutletDetectionClient["generateOutlets"]>().mockImplementation(async request => outletResponse(request));
  const client = { enabled, uploadPage: upload, generateOutlets: generate };
  const hook = renderHook(({ visible }: { visible: boolean }) => {
    const session = useRoiSession();
    return { session, detection: useOutletDetection(session, { enabled: visible }, client) };
  }, { initialProps: { visible: true } });
  const page = outletPage();
  act(() => {
    hook.result.current.session.dispatch({ type: "activate", source: page.source, scale: page.drawing.drawing_scale });
    hook.result.current.session.dispatch({ type: "add", page_id: page.source.page_id, annotation: page.annotations[0] });
    hook.result.current.session.dispatch({ type: "drawing", page_id: page.source.page_id, drawing: page.drawing });
  });
  return { ...hook, upload, generate };
}

describe("explicit outlet detection", () => {
  it("makes no automatic requests and uploads pristine source only after Detect", async () => {
    const hook = setup();
    expect(hook.upload).not.toHaveBeenCalled();
    await act(() => hook.result.current.detection.generate());
    expect(hook.upload.mock.calls[0][0].source_blob).toBe(hook.result.current.session.activePage!.source.source_blob);
    expect(hook.generate.mock.calls[0][0].scopes).toHaveLength(1);
    const page = hook.result.current.session.activePage!;
    expect(page.annotations.filter(annotation => annotation.kind === "rainwater_outlet")).toHaveLength(1);
    expect(page.drawing.outlets).toHaveLength(0);
    expect(hook.result.current.detection.feedback?.status).toBe("complete");
  });

  it("makes no requests with automation disabled or no insulation outline", async () => {
    const disabled = setup(false);
    await act(() => disabled.result.current.detection.generate());
    expect(disabled.upload).not.toHaveBeenCalled();
    const hook = setup();
    act(() => hook.result.current.session.dispatch({ type: "drawing", page_id: "page-1",
      drawing: { ...hook.result.current.session.activePage!.drawing, outlines: [] } }));
    await act(() => hook.result.current.detection.generate());
    expect(hook.upload).not.toHaveBeenCalled();
  });

  it.each(["opening", "scope", "page", "navigation", "cancel"] as const)("aborts and ignores a late response after %s changes", async reason => {
    const hook = setup();
    if (reason === "opening") act(() => hook.result.current.session.dispatch({ type: "add", page_id: "page-1",
      annotation: syntheticAnnotation("opening", { kind: "penetration", roi_id: "roi-1", subtype: "rooflight",
        box_2d: [300, 350, 400, 450], proposed_box_2d: [300, 350, 400, 450], review_status: "suggested" }) }));
    let resolve!: (value: OutletResponse) => void;
    hook.generate.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = hook.result.current.detection.generate(); });
    const [request, signal] = hook.generate.mock.calls[0];
    expect(hook.result.current.detection.busy).toBe(true);
    act(() => {
      const { session, detection } = hook.result.current;
      if (reason === "opening") session.dispatch({ type: "review", page_id: "page-1", id: "opening", patch: { review_status: "accepted" } });
      else if (reason === "scope") session.dispatch({ type: "drawing", page_id: "page-1", drawing: { ...session.activePage!.drawing, holes: [
        { id: "cutout", page_id: "page-1", roi_id: "roi-1", points: [{ x: 350, y: 200 }, { x: 400, y: 200 }, { x: 400, y: 250 }] },
      ] } });
      else if (reason === "page") session.dispatch({ type: "activate", source: syntheticPage("page-2"), scale: { paperSize: "A1", scaleRatio: 50 } });
      else if (reason === "navigation") hook.rerender({ visible: false });
      else detection.cancel();
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve(outletResponse(request)); await pending; });
    expect(hook.result.current.session.state.pages["page-1"].annotations.filter(annotation => annotation.kind === "rainwater_outlet")).toHaveLength(0);
    expect(hook.result.current.detection.busy).toBe(false);
    if (reason === "navigation") {
      act(() => hook.rerender({ visible: true }));
      expect(hook.result.current.detection.busy).toBe(false);
    }
  });

  it("keeps existing recommendations after failure and allows an explicit retry", async () => {
    const hook = setup();
    await act(() => hook.result.current.detection.generate());
    hook.generate.mockRejectedValueOnce(new RoiApiError("provider_timeout"));
    await act(() => hook.result.current.detection.generate());
    expect(hook.result.current.detection.feedback).toMatchObject({ status: "error", error: "provider_timeout" });
    expect(hook.result.current.session.activePage!.annotations.filter(annotation => annotation.kind === "rainwater_outlet")).toHaveLength(1);
    await act(() => hook.result.current.detection.generate());
    expect(hook.result.current.detection.feedback?.status).toBe("complete");
    expect(hook.result.current.session.activePage!.annotations.filter(annotation => annotation.kind === "rainwater_outlet")).toHaveLength(1);
  });
});
