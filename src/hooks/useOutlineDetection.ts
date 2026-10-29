import { useCallback, useEffect, useRef, useState } from "react";
import { roiClient, RoiApiError } from "@/integrations/roi/client";
import type { OutlineBoundaryPolicy, OutlineRequest, OutlineResponse, VectorSegment } from "@/types/outline";
import type { PageSession } from "@/types/roi";
import { outlineResponseError, prepareOutlineApplication } from "@/utils/outlineSession";
import type { useRoiSession } from "./useRoiSession";

interface OutlineOptions { roiId: string | null; boundaryPolicy: OutlineBoundaryPolicy; boundaryNotes?: string; enabled?: boolean }
interface Feedback { status: "uploading" | "generating" | "ready" | "error" | "cancelled"; error?: string }
function contextKey(page: PageSession | null, options: OutlineOptions): string {
  const roi = page?.annotations.find(a => a.id === options.roiId);
  return JSON.stringify([options.enabled !== false, page?.source.page_id, page?.source.source_image_hash,
    page?.roi_revision, page?.geometry_revision, roi?.id, roi?.revision, roi?.review_status, roi?.validity,
    options.boundaryPolicy, options.boundaryNotes ?? ""]);
}
function vectorsForRegion(page: PageSession, box: readonly number[]): VectorSegment[] {
  const w = page.source.source_width, h = page.source.source_height;
  const left = box[1] * w / 1000, top = box[0] * h / 1000, right = box[3] * w / 1000, bottom = box[2] * h / 1000;
  const margin = Math.max(right - left, bottom - top) * 0.08;
  return (page.source.vector_segments ?? []).filter(({ start, end }) => Math.max(start.x, end.x) >= left - margin
    && Math.min(start.x, end.x) <= right + margin && Math.max(start.y, end.y) >= top - margin
    && Math.min(start.y, end.y) <= bottom + margin)
    .sort((a, b) => Math.hypot(b.end.x - b.start.x, b.end.y - b.start.y) - Math.hypot(a.end.x - a.start.x, a.end.y - a.start.y))
    .slice(0, 2000).map(segment => ({ start: { ...segment.start }, end: { ...segment.end } }));
}

export function useOutlineDetection(session: ReturnType<typeof useRoiSession>, options: OutlineOptions, client = roiClient) {
  const [state, setState] = useState<{ key: string; feedback: Feedback | null; result: OutlineResponse | null }>({ key: "", feedback: null, result: null });
  const active = useRef<{ id: string; key: string; controller: AbortController } | null>(null);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const key = contextKey(session.activePage, options);
  useEffect(() => {
    const request = active.current;
    if (request && request.key !== key) { request.controller.abort(); active.current = null; }
    // Do not resurrect a settled result or a cancelled spinner when returning to an old context.
    setState(previous => previous.key && previous.key !== key ? { key, feedback: null, result: null } : previous);
  }, [key]);
  useEffect(() => () => { active.current?.controller.abort(); active.current = null; }, []);

  const cancel = useCallback(() => {
    const request = active.current;
    if (!request) return;
    request.controller.abort();
    active.current = null;
    setState(previous => ({ ...previous, feedback: { status: "cancelled" } }));
  }, []);
  const dismiss = useCallback(() => { cancel(); setState({ key: "", feedback: null, result: null }); }, [cancel]);

  const generate = async () => {
    const page = session.getActivePage();
    const chosen = latestOptions.current;
    const roi = page?.annotations.find(a => a.id === chosen.roiId && a.kind === "roof_roi"
      && a.review_status === "accepted" && a.validity === "current");
    if (!client.enabled || chosen.enabled === false || !page || !roi || active.current) return;
    const requestKey = contextKey(page, chosen);
    if ((chosen.boundaryNotes ?? "").length > 1000) {
      setState({ key: requestKey, result: null, feedback: { status: "error", error: "Boundary notes must be at most 1,000 characters." } });
      return;
    }
    const request: OutlineRequest = { schema_version: "outline-1", page_id: page.source.page_id,
      request_id: crypto.randomUUID(), source_image_hash: page.source.source_image_hash,
      roi_revision: page.roi_revision, geometry_revision: page.geometry_revision,
      roi: { id: roi.id, revision: roi.revision, box_2d: [...roi.box_2d] }, boundary_policy: chosen.boundaryPolicy,
      boundary_notes: chosen.boundaryNotes ?? "", vector_segments: vectorsForRegion(page, roi.box_2d) };
    const controller = new AbortController();
    active.current = { id: request.request_id, key: requestKey, controller };
    const isCurrent = () => !controller.signal.aborted && active.current?.id === request.request_id
      && contextKey(session.getActivePage(), latestOptions.current) === requestKey;
    const update = (feedback: Feedback, result: OutlineResponse | null = null) => setState({ key: requestKey, feedback, result });
    update({ status: "uploading" });
    try {
      await client.uploadPage(page.source, controller.signal);
      if (!isCurrent()) return;
      update({ status: "generating" });
      const result = await client.generateOutline(request, controller.signal);
      if (!isCurrent()) return;
      const current = session.getActivePage();
      const error = current ? outlineResponseError(current, result) : "The selected page changed.";
      if (error) throw new Error(error);
      update({ status: "ready" }, result);
    } catch (error) {
      if (!isCurrent()) return;
      update({ status: "error", error: error instanceof RoiApiError ? error.code
        : error instanceof Error ? error.message : "Outline generation failed." });
    } finally {
      if (active.current?.id === request.request_id) active.current = null;
    }
  };

  const result = state.key === key ? state.result : null;
  const feedback = state.key === key ? state.feedback : null;
  const apply = (replacementIds: string[]): string | null => {
    const page = session.getActivePage();
    if (!page || !result || options.enabled === false) return "Generate and review an outline first.";
    const prepared = prepareOutlineApplication(page, result, replacementIds);
    if (prepared.error) return prepared.error;
    session.dispatch({ type: "apply_outline", page_id: page.source.page_id, result, replace_outline_ids: replacementIds });
    if (session.getActivePage()?.geometry_revision !== page.geometry_revision + 1) return "The drawing changed. Generate a new outline.";
    dismiss();
    return null;
  };
  const canUndo = Boolean(session.activePage?.outline_undo && session.activePage.outline_undo.applied_revision === session.activePage.revision);
  const undo = () => {
    const page = session.getActivePage();
    if (page) session.dispatch({ type: "undo_outline", page_id: page.source.page_id });
    dismiss();
  };
  return { generate, cancel, dismiss, result, feedback, busy: feedback?.status === "uploading" || feedback?.status === "generating", apply, undo, canUndo };
}
