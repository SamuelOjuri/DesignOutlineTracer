import { useState, type FormEvent } from "react";
import { Check, Circle, Loader2, Plus, RotateCcw, Save, Square, Trash2, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { penetrationSubtypes, type Box2D, type PageSession, type RoiAnnotation } from "@/types/roi";
import type { useRoiDetection } from "@/hooks/useRoiDetection";
import { validateBox } from "@/utils/roiCoordinates";
import type { RoiSessionAction } from "@/utils/roiSession";
import { acceptedRoofRegions, penetrationAssociationWarnings } from "@/utils/penetrationAssociation";

interface RoiReviewSidebarProps {
  kind?: "roof_roi" | "penetration";
  page: PageSession;
  selectedId: string | null;
  adding: boolean;
  onSelect: (id: string) => void;
  onAddingChange: (adding: boolean) => void;
  dispatch: (action: RoiSessionAction) => void;
  detection: ReturnType<typeof useRoiDetection>;
}

function BoxForm({ annotation, parents, onSave }: { annotation: RoiAnnotation; parents: RoiAnnotation[];
  onSave: (patch: Partial<Pick<RoiAnnotation, "label" | "box_2d" | "subtype" | "roi_id">>) => void }) {
  const [error, setError] = useState("");
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const label = String(data.get("label") ?? "").trim();
    const box: Box2D = [Number(data.get("top")), Number(data.get("left")), Number(data.get("bottom")), Number(data.get("right"))];
    try {
      validateBox(box);
      if (!label || label.length > 240) throw new Error();
      if (annotation.kind === "penetration") {
        const subtype = penetrationSubtypes.find((candidate) => candidate === data.get("subtype"));
        if (!subtype) throw new Error();
        onSave({ label, box_2d: box, subtype, roi_id: String(data.get("roi_id") ?? "") || null });
      } else onSave({ label, box_2d: box });
      setError("");
    } catch { setError("Use a label and ordered coordinates between 0 and 1000."); }
  };
  return <form onSubmit={save} className="space-y-3 mt-3">
    <label className="block text-sm font-medium">{annotation.kind === "penetration" ? "Penetration label" : "Region label"}
      <Input name="label" defaultValue={annotation.label} required maxLength={240} className="mt-1" />
    </label>
    {annotation.kind === "penetration" && <>
      <label className="block text-sm font-medium">Subtype
        <select name="subtype" defaultValue={annotation.subtype ?? "rooflight"}
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
          {penetrationSubtypes.map((subtype) => <option key={subtype} value={subtype}>{subtype.replace(/_/g, " ")}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium">Parent roof area
        <select name="roi_id" defaultValue={annotation.roi_id ?? ""}
          className="mt-1 h-10 w-full rounded-md border border-input bg-background px-3 text-sm">
          <option value="">Unassigned</option>
          {annotation.roi_id && !parents.some((parent) => parent.id === annotation.roi_id)
            && <option value={annotation.roi_id}>Unavailable parent</option>}
          {parents.map((parent) => <option key={parent.id} value={parent.id}>{parent.label}</option>)}
        </select>
      </label>
    </>}
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

export const RoiReviewSidebar = ({ kind = "roof_roi", page, selectedId, adding, onSelect, onAddingChange, dispatch, detection }: RoiReviewSidebarProps) => {
  const isPenetration = kind === "penetration";
  const subject = isPenetration ? "penetrations" : "roof areas";
  const itemLabel = isPenetration ? "Penetration" : "Roof area";
  const parents = acceptedRoofRegions(page);
  const annotations = page.annotations.filter((annotation) => annotation.kind === kind);
  const selected = annotations.find((annotation) => annotation.id === selectedId);
  const associationWarnings = selected ? penetrationAssociationWarnings(selected, page) : [];
  const canAccept = !isPenetration || Boolean(selected && parents.some((parent) => parent.id === selected.roi_id)
    && penetrationSubtypes.some((subtype) => subtype === selected.subtype));
  const accepted = annotations.filter((annotation) => annotation.review_status === "accepted" && annotation.validity === "current").length;
  const { feedback, busy } = detection;
  const review = (review_status: RoiAnnotation["review_status"]) => {
    if (selected) dispatch({ type: "review", page_id: page.source.page_id, id: selected.id, patch: { review_status, validity: "current" } });
  };
  return <section aria-label={isPenetration ? "Penetration recommendations" : "Roof area recommendations"} className="min-w-0 space-y-4 break-words">
    <div>
      <h2 className="text-lg font-semibold">{isPenetration ? "Penetrations" : "Roof Areas"}</h2>
      <p className="text-sm text-muted-foreground break-all">{page.source.file_name} / Page {page.source.page_index + 1}</p>
      <p className="text-xs text-muted-foreground mt-1">Assisted annotation / {accepted} accepted</p>
    </div>
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">Detection sends this page image to the annotation service and Google Gemini for processing.</p>
      {isPenetration && !parents.length && <p role="status" className="text-sm">No accepted roof areas. Detection is unavailable.</p>}
      {busy ? <Button variant="outline" className="w-full" onClick={detection.cancel}><Square className="w-4 h-4 mr-2" />Cancel detection</Button>
        : <Button className="w-full" disabled={isPenetration && !parents.length} onClick={() => void detection.detect()}>
          <RotateCcw className="w-4 h-4 mr-2" />{feedback?.status === "error" ? "Retry detection" : page.runs.some((run) => run.task === kind) ? "Run detection again" : `Detect ${subject}`}
        </Button>}
      <div role="status" aria-live="polite" className="text-sm">
        {busy && <span className="flex gap-2 items-center"><Loader2 className="w-4 h-4 animate-spin shrink-0" />
          {feedback?.status === "uploading" ? "Uploading selected page..." : `Detecting ${subject}...`}</span>}
        {!busy && feedback?.status === "complete" && "Recommendations ready for review."}
        {!busy && feedback?.status === "no_detections" && `No ${subject} returned. This does not confirm the page has none.`}
        {!busy && feedback?.status === "partial" && `Partial result. Some ${subject} may be missing.`}
        {!busy && feedback?.status === "cancelled" && "Detection cancelled. Existing work is retained."}
      </div>
      {feedback?.status === "error" && <p role="alert" className="text-sm text-destructive">
        {(errorMessages[feedback.error ?? ""] ?? "Detection failed.").replace("regions", isPenetration ? "penetrations" : "regions")} Existing work is retained. ({feedback.error})
      </p>}
      {feedback?.warnings?.map((warning, index) => <p key={index} className="text-xs text-muted-foreground">{warning}</p>)}
      {feedback?.followUpOf && !busy && <Button variant="outline" className="w-full" onClick={() => void detection.detect(feedback.followUpOf)}>
        <Plus className="w-4 h-4 mr-2" />Request one follow-up</Button>}
    </div>
    <TooltipProvider delayDuration={200}>
      <div className="flex gap-2">
        <Button variant={adding ? "default" : "outline"} className="flex-1" aria-pressed={adding} onClick={() => onAddingChange(!adding)}>
          <Plus className="w-4 h-4 mr-2" />{isPenetration ? "Manual penetration" : "Manual region"}</Button>
        <Tooltip><TooltipTrigger asChild><Button variant="outline" size="icon" aria-label="Undo review edit"
          disabled={!page.history.length} onClick={() => dispatch({ type: "undo", page_id: page.source.page_id })}>
          <Undo2 className="w-4 h-4" /></Button></TooltipTrigger><TooltipContent>Undo review edit</TooltipContent></Tooltip>
      </div>
      {!annotations.length && <p className="text-sm text-muted-foreground">No {isPenetration ? "penetrations" : "regions"} yet.</p>}
      {annotations.length > 0 && <ul className="divide-y border-y border-border" aria-label={isPenetration ? "Penetrations" : "Regions"}>
        {annotations.map((annotation, index) => <li key={annotation.id}>
          <button className={`w-full text-left py-3 px-2 min-w-0 focus-visible:ring-2 focus-visible:ring-primary ${annotation.id === selectedId ? "bg-accent" : "hover:bg-muted"}`}
            aria-pressed={annotation.id === selectedId} onClick={() => onSelect(annotation.id)}>
            <span className="flex items-center gap-2 text-sm font-medium">
              {annotation.review_status === "accepted" ? <Check className="w-4 h-4 shrink-0" />
                : annotation.review_status === "rejected" ? <X className="w-4 h-4 shrink-0" /> : <Circle className="w-4 h-4 shrink-0" />}
              {itemLabel} {index + 1}
            </span>
            <span className="block text-xs mt-1 capitalize">{annotation.review_status} / {annotation.origin === "manual" ? "Manual" : "Gemini"}
              {annotation.validity === "needs_review" ? " / Needs review" : ""}</span>
            {isPenetration && <span className="block text-xs mt-1 break-words">{annotation.subtype?.replace(/_/g, " ")} / {
              page.annotations.find((parent) => parent.id === annotation.roi_id)?.label ?? "Unassigned"}</span>}
            {annotation.warnings.length > 0 && <span className="block text-xs mt-1">Review warning</span>}
          </button>
        </li>)}
      </ul>}
      {selected && <div className="border-t border-border pt-3">
        <h3 className="text-sm font-semibold">Selected {isPenetration ? "Penetration" : "Region"}</h3>
        <p className="text-sm mt-1 whitespace-pre-wrap">{selected.label}</p>
        {selected.evidence && <p className="text-sm text-muted-foreground mt-2 whitespace-pre-wrap">{selected.evidence}</p>}
        {selected.warnings.map((warning, index) => <p key={index} className="text-xs mt-2 font-medium">{warning}</p>)}
        {associationWarnings.map((warning) => <p key={warning} className="text-xs mt-2 font-medium">{warning}</p>)}
        <div className="flex flex-wrap gap-2 mt-3">
          <Button size="sm" onClick={() => review("accepted")} disabled={!canAccept || (selected.review_status === "accepted" && selected.validity === "current")}>
            <Check className="w-4 h-4 mr-1" />{isPenetration && (associationWarnings.length > 0 || selected.validity === "needs_review") ? "Confirm association" : "Accept"}</Button>
          <Button size="sm" variant="outline" onClick={() => review("rejected")} disabled={selected.review_status === "rejected"}>
            <X className="w-4 h-4 mr-1" />Reject</Button>
          <Tooltip><TooltipTrigger asChild><Button size="icon" variant="outline" aria-label={isPenetration ? "Delete penetration" : "Delete region"}
            onClick={() => dispatch({ type: "remove", page_id: page.source.page_id, id: selected.id })}>
            <Trash2 className="w-4 h-4" /></Button></TooltipTrigger><TooltipContent>Delete {isPenetration ? "penetration" : "region"}</TooltipContent></Tooltip>
        </div>
        <BoxForm key={`${selected.id}:${selected.revision}`} annotation={selected} parents={parents}
          onSave={(patch) => dispatch({ type: "review", page_id: page.source.page_id, id: selected.id, patch })} />
        <details className="mt-3 text-xs text-muted-foreground">
          <summary className="cursor-pointer">Original {selected.origin === "manual" ? "region" : "proposal"}</summary>
          <p className="mt-1 break-all">[{selected.proposed_box_2d.join(", ")}]</p>
        </details>
      </div>}
    </TooltipProvider>
  </section>;
};