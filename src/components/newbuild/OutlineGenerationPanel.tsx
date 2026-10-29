import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { PageSession, RoiAnnotation } from "@/types/roi";
import type { OutlineBoundaryPolicy, OutlineResponse } from "@/types/outline";
import { Loader2, WandSparkles, Undo2 } from "lucide-react";

const issueMessages: Record<string, string> = {
  provider_not_configured: "Outline generation is unavailable. Configure the annotation service or continue with the manual tools.",
  network_error: "Could not reach the annotation service. Your drawing is unchanged.",
  request_timeout: "Outline generation timed out. Your drawing is unchanged; you can try again.",
  provider_timeout: "Outline generation timed out. Your drawing is unchanged; you can try again.",
  malformed_output: "The model did not return a usable outline. Try again or continue manually.",
  truncated_output: "The model response was incomplete. Try again or continue manually.",
  invalid_response: "The service returned an invalid outline. Your drawing is unchanged.",
  invalid_contract: "The service returned an incompatible outline. Check that the frontend and backend are updated.",
  call_budget_exceeded: "The annotation service's configured call limit has been reached. Manual tools remain available.",
  page_not_found: "The uploaded page has expired. Generate again to upload a fresh copy.",
  roi_too_tight: "The roof appears to extend beyond this region. Review the region before generating again.",
  unsupported_edges: "Some edges have little supporting linework. Review the orange dashed edges.",
  ambiguous_edges: "Some edges have more than one plausible position. Review the orange dashed edges.",
  ambiguous_parallel_edges: "Several nearby lines could define the boundary. Review the orange dashed edges against the selected boundary convention.",
  unsupported_boundary_segments: "Some edges have little supporting linework. Review the orange dashed edges.",
  fitting_rejected: "The initial shape was retained where fitting would change the geometry too much. Check the perimeter before using it.",
  component_conflict: "Fitting would join separate roof components. Their initial shapes were retained for review.",
  roi_boundary_contact: "The perimeter touches the roof-region border. Check that the whole insulation scope is included.",
  scope_outside_roi: "The proposed roof extends outside the accepted region. Review the region before generating again.",
  invalid_outline_geometry: "The model's perimeter is not a valid polygon. Try again or continue with the manual tools.",
  outline_generation_failed: "The perimeter could not be generated. Your drawing is unchanged; try again or continue manually.",
  raster_fallback: "Review the suggested perimeter against the drawing before using it.",
  possible_truncation: "The model response may be incomplete. Check that every roof component is included.",
};

function describeIssue(issue: string) {
  return issueMessages[issue] ?? issue.replace(/_/g, " ");
}

export interface OutlineGenerationPanelProps {
  page: PageSession;
  regions: RoiAnnotation[];
  roiId: string | null;
  onRoiChange: (id: string) => void;
  policy: OutlineBoundaryPolicy;
  onPolicyChange: (policy: OutlineBoundaryPolicy) => void;
  notes: string;
  onNotesChange: (notes: string) => void;
  result: OutlineResponse | null;
  busy: boolean;
  feedback: { status: string; error?: string } | null;
  generate: () => void;
  cancel: () => void;
  dismiss: () => void;
  apply: (replaceIds: string[]) => string | null;
  undo: () => void;
  canUndo: boolean;
  onReviewRegion: () => void;
}

export function OutlineGenerationPanel(props: OutlineGenerationPanelProps) {
  const { page, regions, roiId, result, busy, feedback } = props;
  const [replacements, setReplacements] = useState<string[]>([]);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const available = page.drawing.outlines.filter(outline => !outline.roi_id || outline.roi_id === roiId);
  const warnings = [...new Set([...(result?.warnings ?? []), ...(result?.proposals.flatMap(proposal => proposal.warnings) ?? [])])];
  const usable = Boolean(result?.proposals.length && result.status !== "roi_too_tight" && result.status !== "no_outline");
  const generate = () => { setApplyError(null); setApplied(false); props.generate(); };

  return <section aria-label="Automatic outline" className="mb-5 space-y-3 border-b border-border pb-5">
    <h3 className="text-base font-semibold">Automatic outline</h3>
    {regions.length === 0 ? <>
      <p className="text-sm text-muted-foreground">Accept a roof area to generate its insulation perimeter. Manual tools are also available.</p>
      <Button variant="outline" onClick={props.onReviewRegion}>Review roof areas</Button>
    </> : <>
      <label className="block text-sm font-medium">Roof area
        <select aria-label="Outline roof area" className="mt-1 block w-full rounded-md border border-input bg-background p-2"
          value={roiId ?? ""} onChange={event => { setReplacements([]); setApplied(false); setApplyError(null); props.onRoiChange(event.target.value); }}>
          {regions.map((region, index) => <option key={region.id} value={region.id}>{region.label || `Roof area ${index + 1}`}</option>)}
        </select>
      </label>
      <label className="block text-sm font-medium">Boundary to follow
        <select aria-label="Boundary to follow" className="mt-1 block w-full rounded-md border border-input bg-background p-2"
          value={props.policy} onChange={event => { setApplied(false); props.onPolicyChange(event.target.value as OutlineBoundaryPolicy); }}>
          <option value="inner_parapet">Insulation edge / inner parapet face</option>
          <option value="roof_deck">Roof deck edge</option>
          <option value="outer_roof">Outer roof edge</option>
        </select>
      </label>
      <p className="text-xs text-muted-foreground">Choose the edge that defines this job's insulation scope. Rooflights are reviewed separately.</p>
      <details>
        <summary className="cursor-pointer text-sm">Boundary guidance (optional)</summary>
        <label className="block mt-2 text-sm">Exceptions or edges to follow
          <textarea aria-label="Boundary guidance" value={props.notes} maxLength={1000} rows={3}
            onChange={event => { setApplied(false); props.onNotesChange(event.target.value); }}
            className="mt-1 w-full rounded-md border border-input bg-background p-2" />
        </label>
      </details>
      <p className="text-xs text-muted-foreground">Generation sends a detailed crop and a page overview to the annotation model.</p>
      <div className="flex flex-wrap gap-2">
        <Button onClick={generate} disabled={busy || !roiId} className="flex-1">
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <WandSparkles className="mr-2 h-4 w-4" />}
          {busy ? "Generating outline..." : "Generate outline"}
        </Button>
        {busy && <Button variant="outline" onClick={props.cancel}>Cancel</Button>}
      </div>
      <div aria-live="polite" className="text-sm">
        {feedback?.status === "error" && <p role="alert" className="text-destructive">{describeIssue(feedback.error ?? "Outline generation failed.")}</p>}
        {feedback?.status === "cancelled" && <p>Generation cancelled. Your drawing is unchanged.</p>}
        {result?.status === "no_outline" && <p>No usable perimeter was found. Refine the boundary guidance or use the manual tools.</p>}
        {result?.status === "roi_too_tight" && <p>{issueMessages.roi_too_tight}</p>}
        {usable && <p>{result!.proposals.length} suggested outline{result!.proposals.length === 1 ? "" : "s"}. Blue shows the proposal; orange dashed edges need review.</p>}
        {applied && !result && <p>Outline applied. Use the existing tools for any further adjustments.</p>}
      </div>
      {warnings.length > 0 && <ul className="list-disc space-y-1 pl-4 text-xs text-muted-foreground">
        {warnings.map(warning => <li key={warning}>{describeIssue(warning)}</li>)}
      </ul>}
      {result?.status === "roi_too_tight" && <Button variant="outline" onClick={props.onReviewRegion}>Review roof areas</Button>}
      {usable && <>
        {available.length > 0 && <fieldset className="space-y-2 rounded-md border border-border p-2 text-sm">
          <legend className="px-1 font-medium">Existing outlines to replace</legend>
          <p className="text-xs text-muted-foreground">Leave unchecked to add a new outline. Other outlines are preserved.</p>
          {available.map(outline => <label key={outline.id} className="flex items-start gap-2">
            <input type="checkbox" checked={replacements.includes(outline.id)}
              onChange={event => setReplacements(previous => event.target.checked ? [...previous, outline.id] : previous.filter(id => id !== outline.id))} />
            <span>Outline {page.drawing.outlines.indexOf(outline) + 1}{outline.roi_id ? " (this roof area)" : " (manual)"}</span>
          </label>)}
        </fieldset>}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => {
            const error = props.apply(replacements.filter(id => available.some(outline => outline.id === id)));
            setApplyError(error); setApplied(!error);
            if (!error) setReplacements([]);
          }} disabled={busy}>Use outline</Button>
          <Button variant="outline" onClick={() => { props.dismiss(); setApplyError(null); }}>Discard proposal</Button>
        </div>
      </>}
      {applyError && <p role="alert" className="text-sm text-destructive">{applyError}</p>}
    </>}
    {props.canUndo && <Button variant="outline" size="sm" onClick={() => { props.undo(); setApplied(false); setApplyError(null); }}>
      <Undo2 className="mr-2 h-4 w-4" />Undo generated outline
    </Button>}
  </section>;
}
