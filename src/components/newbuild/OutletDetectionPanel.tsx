import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Undo2, WandSparkles } from "lucide-react";
import type { PageSession, RoiAnnotation } from "@/types/roi";
import { outletSubtypes } from "@/types/outlet";
import type { RoiSessionAction } from "@/utils/roiSession";
import { activePageOutlets, outletAssociation, outletScopes } from "@/utils/outletScope";
import type { useOutletDetection } from "@/hooks/useOutletDetection";

const messages: Record<string, string> = {
  provider_not_configured: "Outlet detection is unavailable. You can still add outlets manually.",
  network_error: "Could not reach the annotation service. Existing outlets are unchanged.",
  request_failed: "Outlet detection failed. Existing outlets are unchanged; try again or add outlets manually.",
  request_timeout: "Outlet detection timed out. Existing outlets are unchanged; you can try again.",
  provider_timeout: "Outlet detection timed out. Existing outlets are unchanged; you can try again.",
  malformed_output: "The model did not return usable outlet positions. Try again or add outlets manually.",
  truncated_output: "The model response was incomplete. Try again or add outlets manually.",
  invalid_response: "The service returned invalid outlet positions. Existing outlets are unchanged.",
  invalid_contract: "The outlet service returned an incompatible response. Check that the frontend and backend are updated.",
  response_identity_mismatch: "The response does not match this drawing and scope. Existing outlets are unchanged.",
  call_budget_exceeded: "The annotation service's configured call limit has been reached. Manual tools remain available.",
  page_not_found: "The uploaded page has expired. Detect again to upload a fresh copy.",
  possible_truncation: "Some outlets may be missing. Review the drawing before continuing.",
  crop_limit_reached: "Only part of the scope was checked. Review the remaining areas manually.",
  outlet_crop_limit_reached: "Only part of the scope was checked. Review the remaining areas manually.",
  outlet_call_budget_reached: "Detection stopped at the configured call limit. Review the remaining areas manually.",
  outlet_annotation_limit_reached: "The result reached the outlet limit. Check the drawing for additional inlets.",
  scope_outside_page: "Review the roof outline before detecting outlets.",
  candidate_outside_scope: "The proposed inlet is outside the insulation scope. Review its position.",
  outlet_outside_scope: "The proposed inlet is outside the insulation scope. Review its position.",
  outlet_in_opening: "The proposed inlet is inside or on an excluded opening. Review its position.",
  possible_duplicate: "A nearby outlet may already represent this inlet. Review before accepting.",
  ambiguous_outlet: "The inlet interpretation is uncertain. Check the source symbol before accepting.",
};
const describe = (message: string) => messages[message] ?? message.replace(/_/g, " ");
const subtypeLabels: Record<string, string> = {
  internal_outlet: "Internal outlet", parapet_outlet: "Parapet outlet", scupper: "Scupper",
};

export interface OutletDetectionPanelProps {
  page: PageSession;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onModeChange?: (mode: "select" | "add-outlets") => void;
  dispatch: (action: RoiSessionAction) => void;
  detection: ReturnType<typeof useOutletDetection>;
}

function OutletCorrections({ page, annotation, dispatch }: {
  page: PageSession; annotation: RoiAnnotation; dispatch: OutletDetectionPanelProps["dispatch"];
}) {
  const [x, setX] = useState(String(annotation.anchor?.x ?? ""));
  const [y, setY] = useState(String(annotation.anchor?.y ?? ""));
  const [diameter, setDiameter] = useState(String(Math.round((annotation.diameter ?? 0.15) * 1000)));
  const [error, setError] = useState<string | null>(null);
  const review = (patch: Extract<RoiSessionAction, { type: "outlet-review" }>["patch"]) =>
    dispatch({ type: "outlet-review", page_id: page.source.page_id, id: annotation.id, patch });
  const scopes = outletScopes(page);
  return <details className="rounded-md border border-border p-2 text-sm">
    <summary className="cursor-pointer">Correct position, type or size</summary>
    <div className="mt-3 space-y-3">
      <label className="block">Outlet type
        <select aria-label="Outlet type" value={annotation.subtype ?? "internal_outlet"}
          onChange={event => review({ subtype: event.target.value as RoiAnnotation["subtype"] })}
          className="mt-1 block w-full rounded-md border border-input bg-background p-2">
          {outletSubtypes.map(subtype => <option key={subtype} value={subtype}>{subtypeLabels[subtype]}</option>)}
        </select>
      </label>
      <label className="block">Assigned roof outline
        <select aria-label="Outlet roof outline" value={`${annotation.roi_id ?? ""}:${annotation.outline_id ?? ""}`}
          onChange={event => {
            const scope = scopes.find(candidate => `${candidate.roi_id}:${candidate.outline_id}` === event.target.value);
            if (scope) review({ roi_id: scope.roi_id, outline_id: scope.outline_id });
          }} className="mt-1 block w-full rounded-md border border-input bg-background p-2">
          {!scopes.some(scope => scope.roi_id === annotation.roi_id && scope.outline_id === annotation.outline_id)
            && <option value={`${annotation.roi_id ?? ""}:${annotation.outline_id ?? ""}`}>Choose a current roof outline</option>}
          {scopes.map(scope => <option key={`${scope.roi_id}:${scope.outline_id}`} value={`${scope.roi_id}:${scope.outline_id}`}>
            {page.annotations.find(candidate => candidate.id === scope.roi_id)?.label || "Roof area"}
            {` / Outline ${page.drawing.outlines.findIndex(outline => outline.id === scope.outline_id) + 1}`}
          </option>)}
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Position uses original page pixels. Drag the marker or enter its inlet centre.</p>
      <div className="grid grid-cols-2 gap-2">
        <label>X position<input aria-label="Outlet X position" type="number" min="0" max={page.source.source_width}
          step="any" value={x} onChange={event => setX(event.target.value)} className="mt-1 w-full rounded-md border border-input p-2" /></label>
        <label>Y position<input aria-label="Outlet Y position" type="number" min="0" max={page.source.source_height}
          step="any" value={y} onChange={event => setY(event.target.value)} className="mt-1 w-full rounded-md border border-input p-2" /></label>
      </div>
      <Button variant="outline" size="sm" onClick={() => {
        const anchor = { x: Number(x), y: Number(y) };
        if (!x.trim() || !y.trim() || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)
          || anchor.x < 0 || anchor.y < 0 || anchor.x > page.source.source_width || anchor.y > page.source.source_height) {
          setError("Enter a position within the source page."); return;
        }
        setError(null);
        dispatch({ type: "outlet-move", page_id: page.source.page_id, id: annotation.id, anchor });
      }}>Apply position</Button>
      <label className="block">Diameter (mm)
        <input aria-label="Outlet diameter (mm)" type="number" min="50" max="1000" step="1" value={diameter}
          onChange={event => setDiameter(event.target.value)} className="mt-1 w-full rounded-md border border-input p-2" />
      </label>
      <p className="text-xs text-muted-foreground">{annotation.diameter_confirmed
        ? "Size confirmed by you. Marker display size is independent of diameter."
        : "150 mm is the application default, not a size measured from the drawing. Confirm or change it if known."}</p>
      <Button variant="outline" size="sm" onClick={() => {
        const millimetres = Number(diameter);
        if (!diameter.trim() || !Number.isFinite(millimetres) || millimetres < 50 || millimetres > 1000) {
          setError("Enter an outlet diameter between 50 and 1,000 mm."); return;
        }
        setError(null); review({ diameter: millimetres / 1000, diameter_confirmed: true });
      }}>Confirm diameter</Button>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  </details>;
}

export function OutletDetectionPanel({ page, selectedId, onSelect, onModeChange, dispatch, detection }: OutletDetectionPanelProps) {
  const annotations = page.annotations.filter(annotation => annotation.kind === "rainwater_outlet" && !annotation.deleted);
  const selected = annotations.find(annotation => annotation.id === selectedId);
  const scopes = outletScopes(page);
  const select = (id: string) => { onSelect(id); onModeChange?.("select"); };
  const review = (id: string, review_status: "accepted" | "rejected") =>
    dispatch({ type: "outlet-review", page_id: page.source.page_id, id, patch: { review_status } });
  const eligible = annotations.filter(annotation => annotation.review_status === "suggested"
    && annotation.validity === "current" && annotation.warnings.length === 0
    && !outletAssociation(page, annotation).error && outletAssociation(page, annotation).warnings.length === 0);
  const association = selected ? outletAssociation(page, selected) : null;
  const warnings = [...new Set([...(selected?.warnings ?? []), ...(association?.warnings ?? [])])];
  const feedback = detection.feedback;
  const accepted = activePageOutlets(page).filter(outlet => outlet.annotation_id).length;

  return <section aria-label="Automatic outlets" className="mb-5 space-y-3 border-b border-border pb-5">
    <h3 className="text-base font-semibold">Automatic outlets</h3>
    <p className="text-xs text-muted-foreground">Find rainwater inlet symbols serving the current insulation scope. Detection sends detailed crops and a page overview to the annotation model.</p>
    {!scopes.length && <p className="text-sm">Accept a roof area and define its insulation outline before detecting outlets. Manual placement remains available.</p>}
    <div className="flex flex-wrap gap-2">
      <Button className="flex-1" disabled={detection.busy || !scopes.length} onClick={() => { onModeChange?.("select"); void detection.generate(); }}>
        {detection.busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />}
        {detection.busy ? "Detecting outlets..." : "Detect outlets"}
      </Button>
      {detection.busy && <Button variant="outline" onClick={detection.cancel}>Cancel</Button>}
    </div>
    <div aria-live="polite" className="text-sm">
      {feedback?.status === "error" && <p role="alert" className="text-destructive">{describe(feedback.error ?? "request_failed")}</p>}
      {feedback?.status === "cancelled" && <p>Detection cancelled. Existing outlets are unchanged.</p>}
      {feedback?.status === "no_detections" && <p>No rainwater inlet symbols were found. Check the drawing and add any missed outlets manually.</p>}
      {feedback?.status === "complete" && <p>Outlet suggestions are ready for review.</p>}
      {feedback?.status === "partial" && <p>Some areas or symbols need further review. The result may be incomplete.</p>}
    </div>
    {Boolean(feedback?.warnings?.length) && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
      {feedback!.warnings!.map(warning => <li key={warning}>{describe(warning)}</li>)}
    </ul>}
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => { onSelect(null); onModeChange?.("add-outlets"); }}>Add manually</Button>
      {eligible.length > 0 && <Button variant="outline" size="sm" disabled={detection.busy}
        onClick={() => eligible.forEach(annotation => review(annotation.id, "accepted"))}>Accept eligible ({eligible.length})</Button>}
      {Boolean(page.outlet_history?.length) && <Button variant="outline" size="sm"
        onClick={() => dispatch({ type: "outlet-undo", page_id: page.source.page_id })}>
        <Undo2 className="mr-1 h-4 w-4" />Undo outlet edit
      </Button>}
    </div>
    {annotations.length > 0 && <p className="text-xs text-muted-foreground">{accepted} accepted / {annotations.length} reviewed or suggested</p>}
    {selected && <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-sm font-medium">{selected.label}</p>
      {selected.evidence && <p className="text-xs text-muted-foreground">{selected.evidence}</p>}
      {association?.error && <p role="alert" className="text-sm text-destructive">{describe(association.error)}</p>}
      {warnings.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        {warnings.map(warning => <li key={warning}>{describe(warning)}</li>)}
      </ul>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={Boolean(association?.error) || detection.busy}
          onClick={() => review(selected.id, "accepted")}>
          {selected.review_status === "accepted" && selected.validity === "needs_review" ? "Confirm outlet" : "Accept outlet"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => review(selected.id, "rejected")}>Reject</Button>
        <Button variant="outline" size="sm" onClick={() => {
          dispatch({ type: "outlet-delete", page_id: page.source.page_id, id: selected.id }); onSelect(null);
        }}>Delete</Button>
      </div>
      <OutletCorrections key={`${selected.id}:${selected.revision}`} page={page} annotation={selected} dispatch={dispatch} />
    </div>}
    <div className="space-y-1" role="group" aria-label="Outlet recommendations">
      {annotations.map((annotation, index) => <button key={annotation.id} type="button" aria-pressed={selectedId === annotation.id}
        onClick={() => select(annotation.id)} className={`block w-full rounded-md border p-2 text-left text-sm ${selectedId === annotation.id ? "border-primary bg-secondary" : "border-border"}`}>
        <span className="block font-medium">{annotation.label || `Outlet ${index + 1}`}</span>
        <span className="text-xs text-muted-foreground">{subtypeLabels[annotation.subtype ?? ""] ?? "Outlet"} · {annotation.review_status}
          {annotation.validity === "needs_review" ? " · needs review" : ""}</span>
      </button>)}
    </div>
  </section>;
}

export function OutletSummary({ pages }: { pages: PageSession[] }) {
  return <section aria-label="Outlet review summary" className="mb-4 space-y-2 rounded-md border border-border p-3 text-sm">
    <h3 className="font-semibold">Outlets</h3>
    {pages.map(page => {
      const annotations = page.annotations.filter(annotation => annotation.kind === "rainwater_outlet" && !annotation.deleted);
      const active = activePageOutlets(page);
      const acceptedIds = new Set(active.flatMap(outlet => outlet.annotation_id ? [outlet.annotation_id] : []));
      const accepted = annotations.filter(annotation => acceptedIds.has(annotation.id));
      const manual = active.filter(outlet => !outlet.annotation_id);
      const unresolved = annotations.filter(annotation => annotation.review_status !== "rejected" && !accepted.includes(annotation));
      const unconfirmed = active.filter(outlet => !outlet.diameter_confirmed).length;
      return <div key={page.source.page_id}>
        <p className="font-medium">{page.source.file_name} / Page {page.source.page_index + 1}</p>
        <p>{accepted.length} accepted detections · {manual.length} manual outlets</p>
        {unresolved.length > 0 && <p className="text-amber-700">{unresolved.length} unresolved suggestion{unresolved.length === 1 ? "" : "s"} excluded from the project output.</p>}
        {unconfirmed > 0 && <p className="text-xs text-muted-foreground">{unconfirmed} outlet size{unconfirmed === 1 ? " uses" : "s use"} an unconfirmed application default.</p>}
      </div>;
    })}
  </section>;
}
