import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { syntheticAnnotation, syntheticPage, syntheticRun } from "@/test/roi";
import { useRoiSession } from "./useRoiSession";
import type { AnnotationKind } from "@/types/roi";

const scale = { paperSize: "A1", scaleRatio: 100 };

function setup() {
  const hook = renderHook(useRoiSession);
  const dispatch = (action: Parameters<typeof hook.result.current.dispatch>[0]) => act(() => hook.result.current.dispatch(action));
  dispatch({ type: "activate", source: syntheticPage(), scale });
  const add = (annotation = syntheticAnnotation()) => dispatch({ type: "add", page_id: "page-1", annotation });
  const start = (task: AnnotationKind = "roof_roi") => {
    let result!: ReturnType<typeof hook.result.current.beginRequest>;
    act(() => { result = hook.result.current.beginRequest(task); });
    return result;
  };
  const page = () => hook.result.current.state.pages["page-1"];
  return { ...hook, dispatch, add, start, page };
}

describe("page-bound annotation sessions", () => {
  it("isolates pages and rejects a late response even after switching back", () => {
    const { dispatch, add, start, page, result } = setup();
    add();
    const old = start();
    dispatch({ type: "activate", source: syntheticPage("page-2"), scale });
    expect(old.signal.aborted).toBe(true);
    expect(result.current.activePage?.annotations).toEqual([]);
    dispatch({ type: "select", page_id: "page-1" });
    dispatch({ type: "result", run: syntheticRun(old.request), annotations: [syntheticAnnotation("late")] });
    expect(page().annotations.map((annotation) => annotation.id)).toEqual(["roi-1"]);
    dispatch({ type: "start", request: old.request });
    expect(page().pending).toEqual({});
  });

  it("cancels superseded requests and rejects wrong request, hash and page identities", () => {
    const { start, dispatch, page } = setup();
    const old = start();
    const current = start();
    expect(old.signal.aborted).toBe(true);
    for (const run of [syntheticRun(old.request), { ...syntheticRun(current.request), source_image_hash: "wrong" },
      { ...syntheticRun(current.request), page_id: "other" }]) {
      dispatch({ type: "result", run, annotations: [syntheticAnnotation()] });
    }
    expect(page().annotations).toEqual([]);
    dispatch({ type: "result", run: syntheticRun(current.request), annotations: [syntheticAnnotation()] });
    expect(page().annotations).toHaveLength(1);
    expect(page().annotations[0].review_status).toBe("suggested");
  });

  it.each(["review", "remove"] as const)("invalidates children on parent %s, preserves edits, and keeps undo revisions monotonic", (type) => {
    const { add, start, dispatch, page } = setup();
    add();
    add(syntheticAnnotation("child", { kind: "penetration", roi_id: "roi-1", box_2d: [200.5, 300, 240, 350] }));
    const originalChild = page().annotations[1];
    const pending = start("penetration");
    const oldRevision = page().roi_revision;
    dispatch(type === "review" ? { type, page_id: "page-1", id: "roi-1", patch: { box_2d: [110, 210, 600, 700] } }
      : { type, page_id: "page-1", id: "roi-1" });
    expect(pending.signal.aborted).toBe(true);
    expect(page().roi_revision).toBeGreaterThan(oldRevision);
    expect(page().annotations.find((annotation) => annotation.id === "child")).toMatchObject({
      box_2d: originalChild.box_2d, review_status: "accepted", validity: "needs_review",
    });
    dispatch({ type: "undo", page_id: "page-1" });
    expect(page().roi_revision).toBeGreaterThan(oldRevision + 1);
    expect(page().annotations.find((annotation) => annotation.id === "roi-1")?.box_2d).toEqual([100, 200, 600, 700]);
    dispatch({ type: "result", run: syntheticRun(pending.request), annotations: [syntheticAnnotation("late", { kind: "penetration", roi_id: "roi-1" })] });
    expect(page().annotations).toHaveLength(2);
    expect(page().annotations.find((annotation) => annotation.id === "child")?.validity).toBe("needs_review");
  });

  it("rejecting a parent only invalidates its own children", () => {
    const { add, dispatch, page } = setup();
    add();
    add(syntheticAnnotation("roi-2"));
    add(syntheticAnnotation("child-1", { kind: "rainwater_outlet", roi_id: "roi-1" }));
    add(syntheticAnnotation("child-2", { kind: "penetration", roi_id: "roi-2" }));
    dispatch({ type: "review", page_id: "page-1", id: "roi-1", patch: { review_status: "rejected" } });
    expect(page().annotations.find((annotation) => annotation.id === "child-1")?.validity).toBe("needs_review");
    expect(page().annotations.find((annotation) => annotation.id === "child-2")?.validity).toBe("current");
  });

  it("requires a parent for child requests and leaves unresolved children needing review", () => {
    const { add, start, page } = setup();
    expect(() => start("penetration")).toThrow("accepted current ROI");
    add(syntheticAnnotation("orphan", { kind: "penetration", roi_id: null }));
    expect(page().annotations[0].validity).toBe("needs_review");
  });

  it("invalidates child requests on manual geometry edits, but not physical scale or outlet changes", () => {
    const { add, start, dispatch, page } = setup();
    add();
    add(syntheticAnnotation("child", { kind: "penetration", roi_id: "roi-1" }));
    const pending = start("penetration");
    dispatch({ type: "drawing", page_id: "page-1", drawing: { ...page().drawing, drawing_scale: { ...scale, scaleRatio: 50 } } });
    expect(pending.signal.aborted).toBe(false);
    expect(page().annotations[0].box_2d).toEqual([100, 200, 600, 700]);
    dispatch({ type: "drawing", page_id: "page-1", drawing: { ...page().drawing, outlines: [
      { id: "outline-1", page_id: "page-1", roi_id: "roi-1", points: [{ x: 1, y: 2 }, { x: 10, y: 20 }, { x: 30, y: 20 }] },
    ] } });
    expect(pending.signal.aborted).toBe(true);
    expect(page().geometry_revision).toBe(1);
    expect(page().annotations[1].validity).toBe("needs_review");
  });

  it("reruns preserve accepted originals and undo does not erase later proposals", () => {
    const { add, start, dispatch, page } = setup();
    add();
    dispatch({ type: "review", page_id: "page-1", id: "roi-1", patch: { label: "Corrected roof" } });
    const accepted = page().annotations[0];
    const pending = start();
    dispatch({ type: "result", run: syntheticRun(pending.request), annotations: [syntheticAnnotation(), syntheticAnnotation("new")] });
    expect(page().annotations[0]).toEqual(accepted);
    expect(page().annotations[1].warnings.join(" ")).toContain("duplicate");
    dispatch({ type: "undo", page_id: "page-1" });
    expect(page().annotations).toHaveLength(2);
    expect(page().annotations.find((annotation) => annotation.id === "new")).toBeDefined();
    expect(page().drawing.outlines).toEqual([]);
  });

  it("preserves original proposed geometry through edits and aborts on unmount", () => {
    const { add, dispatch, page, start, unmount } = setup();
    add();
    dispatch({ type: "review", page_id: "page-1", id: "roi-1", patch: { box_2d: [101.125, 202.25, 605.5, 709.75] } });
    expect(page().annotations[0].proposed_box_2d).toEqual([100, 200, 600, 700]);
    expect(page().annotations[0].edits.at(-1)?.action).toBe("edit");
    const pending = start();
    unmount();
    expect(pending.signal.aborted).toBe(true);
  });

  it("restores a removed child as needing review if geometry changed while it was removed", () => {
    const { add, dispatch, page } = setup();
    add();
    add(syntheticAnnotation("child", { kind: "penetration", roi_id: "roi-1" }));
    dispatch({ type: "remove", page_id: "page-1", id: "child" });
    dispatch({ type: "drawing", page_id: "page-1", drawing: { ...page().drawing, outlines: [
      { id: "outline", page_id: "page-1", roi_id: "roi-1", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] },
    ] } });
    dispatch({ type: "undo", page_id: "page-1" });
    expect(page().annotations.find((annotation) => annotation.id === "child")).toMatchObject({
      review_status: "accepted", validity: "needs_review", roi_id: "roi-1",
    });
  });
});