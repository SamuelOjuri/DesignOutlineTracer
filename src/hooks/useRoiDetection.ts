import { useState } from "react";
import { roiClient, RoiApiError } from "@/integrations/roi/client";
import type { AnnotationKind, PageSession } from "@/types/roi";
import type { useRoiSession } from "./useRoiSession";

interface DetectionFeedback {
  status: "uploading" | "detecting" | "complete" | "no_detections" | "partial" | "error" | "cancelled";
  error?: string;
  warnings?: string[];
  followUpOf?: string;
}

export function useRoiDetection(session: ReturnType<typeof useRoiSession>, client = roiClient, task: AnnotationKind = "roof_roi") {
  const [feedback, setFeedback] = useState<Record<string, DetectionFeedback>>({});
  const [followedRequests] = useState(() => new Set<string>());
  const [followedUploads] = useState(() => new Set<string>());
  const [partialUploads] = useState(() => new Map<string, string>());
  const feedbackKey = (page: PageSession) => task === "roof_roi" ? `${page.source.page_id}:${task}`
    : `${page.source.page_id}:${task}:${page.roi_revision}:${page.geometry_revision}`;

  const cancel = () => {
    const page = session.getActivePage();
    const request = page?.pending[task];
    if (!request) return;
    session.dispatch({ type: "cancel", ...request });
    setFeedback((previous) => ({ ...previous, [feedbackKey(page)]: { status: "cancelled" } }));
  };

  const detect = async (followUpOf?: string) => {
    const page = session.getActivePage();
    if (!client.enabled || !page || page.pending[task]) return;
    const acceptedRois = task === "roof_roi" ? [] : page.annotations.filter((annotation) => annotation.kind === "roof_roi"
      && annotation.review_status === "accepted" && annotation.validity === "current");
    if (task !== "roof_roi" && acceptedRois.length === 0) return;
    if (followUpOf && feedback[feedbackKey(page)]?.followUpOf !== followUpOf) return;
    if (followUpOf && followedRequests.has(followUpOf)) return;
    if (followUpOf) followedRequests.add(followUpOf);
    const { request, signal } = session.beginRequest(task);
    const update = (value: DetectionFeedback) => setFeedback((previous) => ({ ...previous, [feedbackKey(page)]: value }));
    const isCurrent = () => !signal.aborted
      && session.getActivePage()?.pending[task]?.request_id === request.request_id;
    update({ status: "uploading" });
    try {
      const receipt = await client.uploadPage(page.source, signal);
      if (!isCurrent()) return;
      if (followUpOf) {
        if (partialUploads.get(followUpOf) !== receipt.upload_id) throw new RoiApiError("follow_up_expired");
        if (followedUploads.has(receipt.upload_id)) throw new RoiApiError("follow_up_limit");
        followedUploads.add(receipt.upload_id);
      }
      update({ status: "detecting" });
      const result = await client.detect(request, { signal, followUpOf, acceptedRois });
      if (!isCurrent()) return;
      session.dispatch({ type: "result", run: result.run, annotations: result.annotations });
      const allowFollowUp = result.status === "partial" && !followUpOf && !followedUploads.has(receipt.upload_id);
      if (allowFollowUp) partialUploads.set(request.request_id, receipt.upload_id);
      update({ status: result.status, warnings: [...new Set([...result.warnings, ...result.run.warnings])],
        followUpOf: allowFollowUp ? request.request_id : undefined });
    } catch (error) {
      if (!isCurrent()) return;
      session.dispatch({ type: "cancel", ...request });
      update({ status: "error", error: error instanceof RoiApiError ? error.code : "request_failed" });
    }
  };

  const currentFeedback = session.activePage ? feedback[feedbackKey(session.activePage)] : undefined;
  const staleLoading = !session.activePage?.pending[task]
    && (currentFeedback?.status === "uploading" || currentFeedback?.status === "detecting");
  return { detect, cancel, feedback: staleLoading ? { status: "cancelled" as const } : currentFeedback,
    busy: Boolean(session.activePage?.pending[task]) };
}