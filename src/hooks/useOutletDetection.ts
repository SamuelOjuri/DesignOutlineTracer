import { useCallback, useEffect, useRef, useState } from "react";
import { roiClient, RoiApiError } from "@/integrations/roi/client";
import { validateOutletResponse } from "@/integrations/roi/outlets";
import type { OutletRequest, OutletResponse } from "@/types/outlet";
import type { PageSession, RenderedPdfPage } from "@/types/roi";
import { outletScopes, outletScopeSignature } from "@/utils/outletScope";
import type { useRoiSession } from "./useRoiSession";

export interface OutletDetectionFeedback {
  status: "uploading" | "detecting" | "complete" | "partial" | "no_detections" | "error" | "cancelled";
  error?: string;
  warnings?: string[];
}
export interface OutletDetectionClient {
  enabled: boolean;
  uploadPage: (page: RenderedPdfPage, signal?: AbortSignal) => Promise<unknown>;
  generateOutlets: (request: OutletRequest, signal?: AbortSignal) => Promise<OutletResponse>;
}
interface Options { enabled?: boolean }

function contextKey(page: PageSession | null, enabled: boolean) {
  return page ? JSON.stringify([enabled, page.source.page_id, page.source.source_image_hash,
    page.roi_revision, page.geometry_revision, outletScopeSignature(page)]) : "";
}

export function useOutletDetection(session: ReturnType<typeof useRoiSession>, options: Options = {}, client: OutletDetectionClient = roiClient) {
  const enabled = options.enabled !== false;
  const [state, setState] = useState<{ key: string; feedback: OutletDetectionFeedback | null }>({ key: "", feedback: null });
  const active = useRef<{ id: string; key: string; pageId: string } | null>(null);
  const latestEnabled = useRef(enabled);
  latestEnabled.current = enabled;
  const key = contextKey(session.activePage, enabled);
  const dispatch = session.dispatch;

  const cancel = useCallback(() => {
    const request = active.current;
    if (!request) return;
    active.current = null;
    dispatch({ type: "cancel", page_id: request.pageId, task: "rainwater_outlet", request_id: request.id });
    setState(previous => ({ ...previous, feedback: { status: "cancelled" } }));
  }, [dispatch]);

  useEffect(() => {
    if (active.current && active.current.key !== key) cancel();
    setState(previous => previous.key && previous.key !== key ? { key, feedback: null } : previous);
  }, [key, cancel]);
  useEffect(() => () => {
    const request = active.current;
    if (request) dispatch({ type: "cancel", page_id: request.pageId, task: "rainwater_outlet", request_id: request.id });
    active.current = null;
  }, [dispatch]);

  const generate = async () => {
    const page = session.getActivePage();
    if (!client.enabled || !latestEnabled.current || !page || active.current) return;
    const scopes = outletScopes(page);
    if (!scopes.length) return;
    const requestKey = contextKey(page, true);
    const { request: identity, signal } = session.beginRequest("rainwater_outlet");
    const request: OutletRequest = {
      contract_version: "outlet-1", page_id: page.source.page_id, request_id: identity.request_id,
      source_image_hash: page.source.source_image_hash, scope_signature: outletScopeSignature(page),
      roi_revision: page.roi_revision, geometry_revision: page.geometry_revision,
      accepted_rois: page.annotations.filter(annotation => annotation.kind === "roof_roi"
        && annotation.review_status === "accepted" && annotation.validity === "current")
        .map(roi => ({ id: roi.id, revision: roi.revision, box_2d: [...roi.box_2d] })),
      scopes,
    };
    active.current = { id: request.request_id, key: requestKey, pageId: request.page_id };
    const isCurrent = () => !signal.aborted && active.current?.id === request.request_id
      && contextKey(session.getActivePage(), latestEnabled.current) === requestKey;
    const update = (feedback: OutletDetectionFeedback) => setState({ key: requestKey, feedback });
    update({ status: "uploading" });
    try {
      await client.uploadPage(page.source, signal);
      if (!isCurrent()) return;
      update({ status: "detecting" });
      const response = validateOutletResponse(request, await client.generateOutlets(request, signal));
      if (!isCurrent()) return;
      if (response.annotations.some(annotation => annotation.anchor.x > page.source.source_width
        || annotation.anchor.y > page.source.source_height)) throw new RoiApiError("invalid_response");
      session.dispatch({ type: "outlet-result", page_id: request.page_id, request_id: request.request_id,
        scope_signature: request.scope_signature, annotations: response.annotations });
      update({ status: response.status, warnings: response.warnings });
    } catch (error) {
      if (!isCurrent()) return;
      session.dispatch({ type: "cancel", page_id: request.page_id, task: "rainwater_outlet", request_id: request.request_id });
      update({ status: "error", error: error instanceof RoiApiError ? error.code : "request_failed" });
    } finally {
      if (active.current?.id === request.request_id) active.current = null;
    }
  };

  const feedback = state.key === key ? state.feedback : null;
  return { generate, cancel, feedback, busy: feedback?.status === "uploading" || feedback?.status === "detecting" };
}
