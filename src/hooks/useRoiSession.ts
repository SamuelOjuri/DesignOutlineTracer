import { useCallback, useEffect, useRef, useState } from "react";
import type { AnnotationKind, DetectionRequest } from "@/types/roi";
import { initialRoiState, roiSessionReducer, type RoiSessionAction } from "@/utils/roiSession";

export function useRoiSession() {
  const [state, setState] = useState(initialRoiState);
  const current = useRef(state);
  const controllers = useRef(new Map<string, AbortController>());

  const dispatch = useCallback((action: RoiSessionAction) => {
    const next = roiSessionReducer(current.current, action);
    current.current = next;
    const pendingIds = new Set(Object.values(next.pages).flatMap((page) => Object.values(page.pending).map((request) => request.request_id)));
    for (const [id, controller] of controllers.current) {
      if (!pendingIds.has(id)) {
        controller.abort();
        controllers.current.delete(id);
      }
    }
    setState(next);
  }, []);

  useEffect(() => {
    const activeControllers = controllers.current;
    return () => {
      for (const controller of activeControllers.values()) controller.abort();
      activeControllers.clear();
    };
  }, []);

  const beginRequest = (task: AnnotationKind) => {
    const page = current.current.pages[current.current.active_page_id ?? ""];
    if (!page) throw new Error("Select a rendered page first");
    const request: DetectionRequest = { page_id: page.source.page_id, request_id: crypto.randomUUID(), task,
      source_image_hash: page.source.source_image_hash, roi_revision: task === "roof_roi" ? null : page.roi_revision,
      geometry_revision: page.geometry_revision };
    dispatch({ type: "start", request });
    if (current.current.pages[request.page_id].pending[task]?.request_id !== request.request_id) {
      throw new Error("Child detection requires an accepted current ROI");
    }
    const controller = new AbortController();
    controllers.current.set(request.request_id, controller);
    return { request, signal: controller.signal };
  };

  const getActivePage = () => current.current.pages[current.current.active_page_id ?? ""] ?? null;
  return { state, dispatch, beginRequest, getActivePage, activePage: state.pages[state.active_page_id ?? ""] ?? null };
}