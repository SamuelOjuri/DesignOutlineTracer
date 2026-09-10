import { useState, type FormEvent } from "react";
import { Check, Circle, Loader2, Plus, RotateCcw, Save, Square, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Box2D, PageSession, RoiAnnotation } from "@/types/roi";
import type { useRoiDetection } from "@/hooks/useRoiDetection";
import { validateBox } from "@/utils/roiCoordinates";
import type { RoiSessionAction } from "@/utils/roiSession";

interface RoiReviewSidebarProps {
  page: PageSession;
  selectedId: string | null;
  adding: boolean;
  onSelect: (id: string) => void;
  onAddingChange: (adding: boolean) => void;
  dispatch: (action: RoiSessionAction) => void;
  detection: ReturnType<typeof useRoiDetection>;
}

function BoxForm({ annotation, onSave }: { annotation: RoiAnnotation; onSave: (label: string, box: Box2D) => void }) {
  const [error, setError] = useState("");
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const label = String(data.get("label") ?? "").trim();
    const box: Box2D = [Number(data.get("top")), Number(data.get("left")), Number(data.get("bottom")), Number(data.get("right"))];
    try {
      validateBox(box);
      if (!label || label.length > 240) throw new Error();
      onSave(label, box);
      setError("");
    } catch { setError("Use a label and ordered coordinates between 0 and 1000."); }
  };
  return <form onSubmit={save} className="space-y-3 mt-3">
    <label className="block text-sm font-medium">Region label
      <Input name="label" defaultValue={annotation.label} required maxLength={240} className="mt-1" />
    </label>
    <fieldset>
      <legend className="text-xs text-muted-foreground mb-2">Page coordinates (0-1000)</legend>
      <div className="grid grid-cols-2 gap-2">
        {["top", "left", "bottom", "right"].map((name, index) => <label key={name} className="text-xs capitalize">{name}
          <Input type="number" name={name} required min={0} max={1000} step="any" defaultValue={annotation.box_2d[index]}
            className="mt-1 min-w-0" />
        </label>)}
      </div>
    </fieldset>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" variant="outline" className="w-full"><Save className="w-4 h-4 mr-2" />Apply correction</Button>
  </form>;
}

const errorMessages: Record<string, string> = {
  network_error: "The annotation service is unavailable.", request_timeout: "The annotation request timed out.",
  provider_timeout: "The model request timed out.", live_calls_disabled: "Live model calls are disabled on this service.",
  provider_not_configured: "Live model access is not configured on this service.",
  malformed_output: "The model response could not be validated. No new regions were added.",
  truncated_output: "The model response ended before valid annotations were complete. No new regions were added.",
  call_budget_exceeded: "The model-call budget has been used. Further detection requires an approved budget reset.",
  follow_up_expired: "The earlier upload expired. Start a new detection run.",
  follow_up_limit: "The follow-up limit for this upload has been reached.",
  invalid_configuration: "The annotation service URL is not configured for localhost.",
  model_unavailable: "The configured model is unavailable.", provider_refusal: "The model declined this request.",
};

export const RoiReviewSidebar = ({ page, selectedId, adding, onSelect, onAddingChange, dispatch, detection }: RoiReviewSidebarProps) => {
  const annotations = page.annotations.filter((annotation) => annotation.kind === "roof_roi");
  const selected = annotations.find((annotation) => annotation.id === selectedId);
  const accepted = annotations.filter((annotation) => annotation.review_status === "accepted" && annotation.validity === "current").length;
  const { feedback, busy } = detection;
  const review = (review_status: RoiAnnotation["review_status"]) => {
    if (selected) dispatch({ type: "review", page_id: page.source.page_id, id: selected.id, patch: { review_status, validity: "current" } });
  };
  return <section aria-label="Roof area recommendations" className="min-w-0 space-y-4 break-words">
    <div>
      <h2 className="text-lg font-semibold">Roof Areas</h2>
      <p className="text-sm text-muted-foreground break-all">{page.source.file_name} / Page {page.source.page_index + 1}</p>
      <p className="text-xs text-muted-foreground mt-1">Assisted annotation / {accepted} accepted</p>
    </div>
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Detection sends this page image to the annotation service and Google Gemini for processing.</p>
      {busy ? <Button variant="outline" className="w-full" onClick={detection.cancel}><Square className="w-4 h-4 mr-2" />Cancel detection</Button>
        : <Button className="w-full" onClick={() => void detection.detect()}>
          <RotateCcw className="w-4 h-4 mr-2" />{feedback?.status === "error" ? "Retry detection" : page.runs.length ? "Run detection again" : "Detect roof areas"}
        </Button>}
      <div role="status" aria-live="polite" className="text-sm">
        {busy && <span className="flex gap-2 items-center"><Loader2 className="w-4 h-4 animate-spin shrink-0" />
          {feedback?.status === "uploading" ? "Uploading selected page..." : "Detecting roof areas..."}</span>}
        {!busy && feedback?.status === "complete" && "Recommendations ready for review."}
        {!busy && feedback?.status === "no_detections" && "No roof areas returned. This does not confirm the page has none."}
        {!busy && feedback?.status === "partial" && "Partial result. Some roof areas may be missing."}
        {!busy && feedback?.status === "cancelled" && "Detection cancelled. Existing work is retained."}
      </div>
      {feedback?.status === "error" && <p role="alert" className="text-sm text-destructive">
        {errorMessages[feedback.error ?? ""] ?? "Detection failed."} Existing work is retained. ({feedback.error})
      </p>}
      {feedback?.warnings?.map((warning, index) => <p key={index} className="text-xs text-muted-foreground">{warning}</p>)}
      {feedback?.followUpOf && !busy && <Button variant="outline" className="w-full" onClick={() => void detection.detect(feedback.followUpOf)}>
        <Plus className="w-4 h-4 mr-2" />Request one follow-up</Button>}
    </div>
    <TooltipProvider delayDuration={200}>
      <div className="flex gap-2">
        <Button variant={adding ? "default" : "outline"} className="flex-1" aria-pressed={adding} onClick={() => onAddingChange(!adding)}>
          <Plus className="w-4 h-4 mr-2" />Manual region</Button>
        <Tooltip><TooltipTrigger asChild><Button variant="outline" size="icon" aria-label="Undo review edit"
          disabled={!page.history.length} onClick={() => dispatch({ type: "undo", page_id: page.source.page_id })}>
          <Undo2 className="w-4 h-4" /></Button></TooltipTrigger><TooltipContent>Undo review edit</TooltipContent></Tooltip>
      </div>
      {!annotations.length && <p className="text-sm text-muted-foreground">No regions yet.</p>}
      {annotations.length > 0 && <ul className="divide-y border-y border-border" aria-label="Regions">
        {annotations.map((annotation, index) => <li key={annotation.id}>
          <button className={`w-full text-left py-3 px-2 min-w-0 focus-visible:ring-2 focus-visible:ring-primary ${annotation.id === selectedId ? "bg-accent" : "hover:bg-muted"}`}
            aria-pressed={annotation.id === selectedId} onClick={() => onSelect(annotation.id)}>
            <span className="flex items-center gap-2 text-sm font-medium">
              {annotation.review_status === "accepted" ? <Check className="w-4 h-4 shrink-0" />
                : annotation.review_status === "rejected" ? <X className="w-4 h-4 shrink-0" /> : <Circle className="w-4 h-4 shrink-0" />}
              Roof area {index + 1}
            </span>
            <span className="block text-xs mt-1 capitalize">{annotation.review_status} / {annotation.origin === "manual" ? "Manual" : "Gemini"}
              {annotation.validity === "needs_review" ? " / Needs review" : ""}</span>
            {annotation.warnings.length > 0 && <span className="block text-xs mt-1">Review warning</span>}
          </button>
        </li>)}
      </ul>}
      {selected && <div className="border-t border-border pt-3">
        <h3 className="text-sm font-semibold">Selected Region</h3>
        <p className="text-sm mt-1 whitespace-pre-wrap">{selected.label}</p>
        {selected.evidence && <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">{selected.evidence}</p>}
        {selected.warnings.map((warning, index) => <p key={index} className="text-xs mt-2 font-medium">{warning}</p>)}
        <div className="flex flex-wrap gap-2 mt-3">
          <Button size="sm" onClick={() => review("accepted")} disabled={selected.review_status === "accepted" && selected.validity === "current"}>
            <Check className="w-4 h-4 mr-1" />Accept</Button>
          <Button size="sm" variant="outline" onClick={() => review("rejected")} disabled={selected.review_status === "rejected"}>
            <X className="w-4 h-4 mr-1" />Reject</Button>
          <Tooltip><TooltipTrigger asChild><Button size="icon" variant="outline" aria-label="Delete region"
            onClick={() => dispatch({ type: "remove", page_id: page.source.page_id, id: selected.id })}>
            <Trash2 className="w-4 h-4" /></Button></TooltipTrigger><TooltipContent>Delete region</TooltipContent></Tooltip>
        </div>
        <BoxForm key={`${selected.id}:${selected.revision}`} annotation={selected}
          onSave={(label, box_2d) => dispatch({ type: "review", page_id: page.source.page_id, id: selected.id, patch: { label, box_2d } })} />
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Original {selected.origin === "manual" ? "region" : "proposal"}</summary>
          <p className="mt-1 break-all">[{selected.proposed_box_2d.join(", ")}]</p>
        </details>
      </div>}
    </TooltipProvider>
  </section>;
};