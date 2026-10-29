import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRoiClient } from "@/integrations/roi/client";
import { syntheticAnnotation, syntheticPage } from "@/test/roi";
import { outlineResponse } from "@/test/outline";
import type { OutlineBoundaryPolicy, OutlineResponse } from "@/types/outline";
import { useRoiSession } from "./useRoiSession";
import { useOutlineDetection } from "./useOutlineDetection";

function setup(enabled = true) {
  const client = createRoiClient({ enabled });
  const upload = vi.spyOn(client, "uploadPage").mockResolvedValue({ page: {
    ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 400, 300] }, upload_id: "upload", expires_in_seconds: 100 });
  const detect = vi.spyOn(client, "generateOutline").mockImplementation(async request => outlineResponse(request));
  const hook = renderHook(({ boundaryPolicy, visible }: { boundaryPolicy: OutlineBoundaryPolicy; visible: boolean }) => {
    const session = useRoiSession();
    return { session, outline: useOutlineDetection(session, { roiId: "roi-1", boundaryPolicy, enabled: visible }, client) };
  }, { initialProps: { boundaryPolicy: "inner_parapet", visible: true } });
  act(() => {
    hook.result.current.session.dispatch({ type: "activate", source: syntheticPage(), scale: { paperSize: "A1", scaleRatio: 50 } });
    hook.result.current.session.dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation() });
  });
  return { ...hook, upload, detect };
}

describe("explicit outline requests", () => {
  it("does no networking without the feature or a current accepted ROI", async () => {
    const disabled = setup(false);
    await act(() => disabled.result.current.outline.generate());
    expect(disabled.upload).not.toHaveBeenCalled();
    const current = setup();
    act(() => current.result.current.session.dispatch({ type: "review", page_id: "page-1", id: "roi-1", patch: { review_status: "rejected" } }));
    await act(() => current.result.current.outline.generate());
    expect(current.upload).not.toHaveBeenCalled();
  });

  it.each(["geometry", "roi", "policy", "page", "navigation", "cancel"] as const)("aborts and ignores a delayed response after %s changes", async reason => {
    const hook = setup();
    let resolve!: (value: OutlineResponse) => void;
    hook.detect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    let pending!: Promise<void>;
    await act(async () => { pending = hook.result.current.outline.generate(); });
    const [request, signal] = hook.detect.mock.calls[0];
    expect(hook.result.current.outline.busy).toBe(true);
    act(() => {
      const { session, outline } = hook.result.current;
      if (reason === "geometry") session.dispatch({ type: "drawing", page_id: "page-1", drawing: {
        ...session.activePage!.drawing, outlines: [{ id: "manual", page_id: "page-1", roi_id: null,
          points: [{ x: 200, y: 100 }, { x: 300, y: 100 }, { x: 250, y: 200 }] }] } });
      else if (reason === "roi") session.dispatch({ type: "review", page_id: "page-1", id: "roi-1", patch: { box_2d: [100, 100, 600, 800] } });
      else if (reason === "page") session.dispatch({ type: "activate", source: syntheticPage("page-2"), scale: { paperSize: "A1", scaleRatio: 50 } });
      else if (reason === "policy") hook.rerender({ boundaryPolicy: "outer_roof", visible: true });
      else if (reason === "navigation") hook.rerender({ boundaryPolicy: "inner_parapet", visible: false });
      else outline.cancel();
    });
    expect(signal?.aborted).toBe(true);
    await act(async () => { resolve(outlineResponse(request)); await pending; });
    expect(hook.result.current.outline.result).toBeNull();
    expect(hook.result.current.outline.busy).toBe(false);
    if (reason === "policy" || reason === "navigation") {
      act(() => hook.rerender({ boundaryPolicy: "inner_parapet", visible: true }));
      expect(hook.result.current.outline.busy).toBe(false);
      expect(hook.result.current.outline.result).toBeNull();
    }
  });

  it("keeps detection separate from application and applies and undoes one geometry change", async () => {
    const hook = setup();
    await act(() => hook.result.current.outline.generate());
    expect(hook.result.current.session.activePage!.drawing.outlines).toEqual([]);
    expect(hook.result.current.outline.result?.proposals).toHaveLength(1);
    act(() => expect(hook.result.current.outline.apply([])).toBeNull());
    expect(hook.result.current.session.activePage!.drawing.outlines).toHaveLength(1);
    expect(hook.result.current.outline.canUndo).toBe(true);
    act(() => hook.result.current.outline.undo());
    expect(hook.result.current.session.activePage!.drawing.outlines).toEqual([]);
    expect(hook.result.current.outline.canUndo).toBe(false);
  });

  it("discards a settled proposal when leaving the outline step", async () => {
    const hook = setup();
    await act(() => hook.result.current.outline.generate());
    act(() => hook.rerender({ boundaryPolicy: "inner_parapet", visible: false }));
    act(() => hook.rerender({ boundaryPolicy: "inner_parapet", visible: true }));
    expect(hook.result.current.outline.result).toBeNull();
  });
});
