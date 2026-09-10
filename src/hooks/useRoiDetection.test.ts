import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createRoiClient, RoiApiError, type RoiDetectionResult } from "@/integrations/roi/client";
import { syntheticAnnotation, syntheticPage, syntheticRun } from "@/test/roi";
import { useRoiSession } from "./useRoiSession";
import { useRoiDetection } from "./useRoiDetection";

function setup(enabled = true) {
  const client = createRoiClient({ enabled });
  const upload = vi.spyOn(client, "uploadPage").mockResolvedValue({
    page: { ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 800, 600] }, upload_id: "upload", expires_in_seconds: 900,
  });
  const detect = vi.spyOn(client, "detect").mockImplementation(async (request) => ({
    schema_version: "1", ...request, status: "partial", model: "gemini-3.6-flash", prompt_version: "roof-roi-v1",
    annotations: [syntheticAnnotation("proposal", { review_status: "suggested" })], warnings: ["Possible truncation"],
    run: { ...syntheticRun(request), status: "partial", cached: false, provider_attempts: 1 },
  }));
  const hook = renderHook(() => {
    const session = useRoiSession();
    return { session, detection: useRoiDetection(session, client) };
  });
  act(() => hook.result.current.session.dispatch({ type: "activate", source: syntheticPage(), scale: { paperSize: "A1", scaleRatio: 100 } }));
  return { ...hook, upload, detect };
}

describe("explicit ROI detection", () => {
  it("uploads only on demand and offers one follow-up while keeping manual geometry empty", async () => {
    const { result, upload, detect } = setup();
    expect(upload).not.toHaveBeenCalled();
    await act(() => result.current.detection.detect());
    expect(upload.mock.calls[0][0].source_blob).toBe(result.current.session.activePage!.source.source_blob);
    expect(result.current.session.activePage!.drawing.outlines).toEqual([]);
    const followUp = result.current.detection.feedback!.followUpOf!;
    expect(followUp).toBeTruthy();
    await act(() => result.current.detection.detect(followUp));
    expect(detect.mock.calls[1][1].followUpOf).toBe(followUp);
    expect(result.current.detection.feedback!.followUpOf).toBeUndefined();
    await act(() => result.current.detection.detect(followUp));
    expect(detect).toHaveBeenCalledTimes(2);
    await act(() => result.current.detection.detect());
    expect(result.current.detection.feedback!.followUpOf).toBeUndefined();
  });

  it("does not send a follow-up for an expired upload", async () => {
    const { result, upload, detect } = setup();
    await act(() => result.current.detection.detect());
    const followUp = result.current.detection.feedback!.followUpOf!;
    upload.mockResolvedValueOnce({ page: { ...syntheticPage(), render_rotation: 0, pdf_view_box: [0, 0, 800, 600] },
      upload_id: "replacement-upload", expires_in_seconds: 900 });
    await act(() => result.current.detection.detect(followUp));
    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.current.detection.feedback).toEqual({ status: "error", error: "follow_up_expired" });
    expect(result.current.session.activePage!.annotations).toHaveLength(1);
  });

  it("does no networking when disabled", async () => {
    const { result, upload } = setup(false);
    await act(() => result.current.detection.detect());
    expect(upload).not.toHaveBeenCalled();
  });

  it.each(["cancel", "switch"])("ignores a late result after %s, including switching back", async (action) => {
    const { result, detect } = setup();
    let resolve!: (value: RoiDetectionResult) => void;
    detect.mockImplementationOnce(() => new Promise((finish) => { resolve = finish; }));
    let pending!: Promise<void>;
    await act(async () => { pending = result.current.detection.detect(); });
    const request = result.current.session.activePage!.pending.roof_roi!;
    const signal = detect.mock.calls[0][1].signal!;
    act(() => {
      if (action === "cancel") result.current.detection.cancel();
      else {
        result.current.session.dispatch({ type: "activate", source: syntheticPage("page-2"), scale: { paperSize: "A1", scaleRatio: 100 } });
        result.current.session.dispatch({ type: "select", page_id: "page-1" });
      }
    });
    expect(signal.aborted).toBe(true);
    await act(async () => {
      resolve({ schema_version: "1", ...request, status: "complete", model: "gemini-3.6-flash", prompt_version: "roof-roi-v1",
        warnings: [], annotations: [syntheticAnnotation()], run: { ...syntheticRun(request), cached: false, provider_attempts: 1 } });
      await pending;
    });
    expect(result.current.session.activePage!.annotations).toEqual([]);
    expect(result.current.detection.feedback!.status).toBe("cancelled");
  });

  it.each(["network_error", "malformed_output", "truncated_output", "call_budget_exceeded"])("keeps accepted edits after %s and allows only an explicit retry", async (code) => {
    const { result, detect } = setup();
    act(() => result.current.session.dispatch({ type: "add", page_id: "page-1", annotation: syntheticAnnotation() }));
    detect.mockRejectedValueOnce(new RoiApiError(code));
    await act(() => result.current.detection.detect());
    expect(result.current.detection.feedback).toEqual({ status: "error", error: code });
    expect(detect).toHaveBeenCalledTimes(1);
    expect(result.current.session.activePage!.pending).toEqual({});
    expect(result.current.session.activePage!.runs).toEqual([]);
    expect(result.current.session.activePage!.annotations).toHaveLength(1);
    expect(result.current.session.activePage!.annotations[0].review_status).toBe("accepted");
    await act(() => result.current.detection.detect());
    expect(result.current.session.activePage!.annotations).toHaveLength(2);
  });
});