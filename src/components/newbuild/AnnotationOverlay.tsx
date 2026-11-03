import type { CSSProperties, KeyboardEvent } from "react";
import type { Box2D, RoiAnnotation } from "@/types/roi";
import { editRoiBox, type BoxHandle } from "@/utils/roiBoxEditing";
import { OUTLINE_APPEARANCE } from "@/utils/outlineAppearance";

interface AnnotationOverlayProps {
  annotations: readonly RoiAnnotation[];
  selectedId?: string | null;
  /** Mark the automatic outline target without adding ROI editing controls. */
  outlineTargetId?: string | null;
  draft?: { id: string; box: Box2D } | null;
  draftKind?: RoiAnnotation["kind"];
  interactive?: boolean;
  labels?: Record<string, string>;
  labelsAbove?: boolean;
  /** De-emphasise read-only region guides while a proposed or accepted outline is visible. */
  contextual?: boolean;
  /** These boundaries are already painted by the geometry layer; retain only their editing controls. */
  boundaryRenderedIds?: ReadonlySet<string>;
  onSelect?: (id: string) => void;
  onEdit?: (id: string, box: Box2D) => void;
}

const boxStyle = (box: Box2D): CSSProperties => ({
  top: `${box[0] / 10}%`, left: `${box[1] / 10}%`, height: `${(box[2] - box[0]) / 10}%`, width: `${(box[3] - box[1]) / 10}%`,
});

export const AnnotationOverlay = ({ annotations, selectedId, outlineTargetId, draft, draftKind = "roof_roi", interactive = false, labels, labelsAbove = false, contextual = false, boundaryRenderedIds, onSelect, onEdit }: AnnotationOverlayProps) => {
  const keyboardEdit = (event: KeyboardEvent, annotation: RoiAnnotation, handle: BoxHandle) => {
    const amount = event.shiftKey ? 10 : 1;
    const deltas = { ArrowLeft: { x: -amount, y: 0 }, ArrowRight: { x: amount, y: 0 },
      ArrowUp: { x: 0, y: -amount }, ArrowDown: { x: 0, y: amount } };
    const delta = deltas[event.key as keyof typeof deltas];
    if (!delta) return;
    event.preventDefault();
    onEdit?.(annotation.id, editRoiBox(annotation.box_2d, delta, handle));
  };

  return (
    <div className="absolute inset-0 pointer-events-none" data-testid="annotation-overlay">
      {annotations.map((annotation, index) => {
        const box = draft?.id === annotation.id ? draft.box : annotation.box_2d;
        const selected = annotation.id === selectedId;
        const outlineTarget = annotation.id === outlineTargetId;
        const boundaryRendered = boundaryRenderedIds?.has(annotation.id) ?? false;
        const label = labels?.[annotation.id] ?? `${annotation.kind === "penetration" ? "Penetration" : "Roof area"} ${index + 1}`;
        const status = annotation.validity === "needs_review" ? "Needs review" : annotation.review_status;
        const bluePenetration = annotation.kind === "penetration" && annotation.review_status !== "rejected";
        const acceptedRoof = annotation.kind === "roof_roi" && annotation.review_status === "accepted";
        const subdued = contextual && !interactive && !selected && annotation.review_status === "accepted"
          && annotation.validity !== "needs_review";
        const dashedRoofGuide = subdued && annotation.kind === "roof_roi" && !boundaryRendered;
        const color = subdued ? "border-[#059669]/40 text-[#059669]" : annotation.review_status === "accepted" ? "border-[#059669] text-[#059669]"
          : annotation.review_status === "rejected" ? "border-gray-500 text-gray-700" : "border-sky-700 text-sky-900";
        const style: CSSProperties = { ...boxStyle(box), ...(bluePenetration ? {
          borderColor: OUTLINE_APPEARANCE.stroke, color: OUTLINE_APPEARANCE.stroke, outlineColor: OUTLINE_APPEARANCE.stroke,
        } : {}) };
        const className = `absolute ${boundaryRendered || dashedRoofGuide ? "border-0" : subdued ? "border border-dashed" : selected && acceptedRoof ? "border-[3px]" : "border-2"} ${color} ${annotation.review_status !== "accepted" ? "border-dashed" : ""}
          ${selected ? `z-10 ${boundaryRendered ? "" : acceptedRoof ? "ring-2 ring-white" : "ring-2 ring-white outline outline-2 outline-sky-900"}` : ""}`;
        return (
          <div key={annotation.id} className={className} style={style} data-testid={`annotation-box-${annotation.id}`}
            data-box={JSON.stringify(box)} data-status={annotation.review_status} data-contextual={subdued}>
            {dashedRoofGuide && <svg className="absolute inset-0 h-full w-full overflow-visible pointer-events-none" aria-hidden="true">
              <rect width="100%" height="100%" fill="none" stroke="#059669" strokeOpacity={0.65}
                strokeWidth={1.25} strokeDasharray="8 5" vectorEffect="non-scaling-stroke" />
            </svg>}
            {interactive ? (
              <button type="button" data-annotation-id={annotation.id} aria-label={`${label}: ${status}`} aria-pressed={selected}
                title={`${label}: ${annotation.label} (${status})`}
                className={`absolute inset-0 w-full h-full pointer-events-auto cursor-move focus-visible:outline focus-visible:outline-2 ${boundaryRendered ? "focus-visible:outline-offset-4" : ""} ${bluePenetration ? "focus-visible:outline-current" : acceptedRoof ? "focus-visible:outline-[#059669]" : "focus-visible:outline-primary"}`}
                onClick={() => onSelect?.(annotation.id)} onKeyDown={(event) => keyboardEdit(event, annotation, "move")} />
            ) : null}
            <span className={`absolute ${labelsAbove && box[0] > 40 ? "bottom-full" : "top-0"} whitespace-nowrap ${outlineTarget && !subdued ? "bg-transparent text-[#059669]" : "bg-white/95"} px-1 text-xs font-semibold leading-5`}
              aria-current={outlineTarget ? "true" : undefined}
              style={annotation.kind === "penetration" ? (box[3] < 900 ? { left: "calc(100% + 8px)" } : { right: "calc(100% + 8px)" })
                : box[1] > 500 ? { right: 0 } : { left: 0 }} title={`${label}: ${outlineTarget ? "selected for outline generation" : status}`}>
              {annotation.kind === "penetration" ? `P${index + 1}` : label}
            </span>
            {interactive && selected && (["nw", "ne", "sw", "se"] as const).map((handle) => (
              <button key={handle} type="button" aria-label={`Resize ${label} ${handle}`} title={`Resize ${label} ${handle}`}
                data-annotation-id={annotation.id} data-handle={handle}
                className={`absolute w-3 h-3 bg-white border-2 ${acceptedRoof ? "border-[#059669]" : "border-sky-800"} pointer-events-auto focus-visible:ring-2 ${bluePenetration ? "focus-visible:ring-current" : acceptedRoof ? "focus-visible:ring-[#059669]" : "focus-visible:ring-primary"}`}
                style={{ top: handle.includes("n") ? -6 : undefined, bottom: handle.includes("s") ? -6 : undefined,
                  left: handle.includes("w") ? -6 : undefined, right: handle.includes("e") ? -6 : undefined,
                  borderColor: bluePenetration ? OUTLINE_APPEARANCE.stroke : undefined,
                  cursor: handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize" }}
                onKeyDown={(event) => keyboardEdit(event, annotation, handle)} />
            ))}
          </div>
        );
      })}
      {draft?.id === "new" && <div className="absolute border-2 border-dashed border-sky-700 bg-sky-100/20"
        style={{ ...boxStyle(draft.box), borderColor: draftKind === "penetration" ? OUTLINE_APPEARANCE.stroke : undefined }} />}
    </div>
  );
};
