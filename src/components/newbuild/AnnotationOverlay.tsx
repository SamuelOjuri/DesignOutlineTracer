import type { CSSProperties, KeyboardEvent } from "react";
import type { Box2D, RoiAnnotation } from "@/types/roi";
import { editRoiBox, type BoxHandle } from "@/utils/roiBoxEditing";

interface AnnotationOverlayProps {
  annotations: readonly RoiAnnotation[];
  selectedId?: string | null;
  draft?: { id: string; box: Box2D } | null;
  interactive?: boolean;
  labels?: Record<string, string>;
  onSelect?: (id: string) => void;
  onEdit?: (id: string, box: Box2D) => void;
}

const boxStyle = (box: Box2D): CSSProperties => ({
  top: `${box[0] / 10}%`, left: `${box[1] / 10}%`, height: `${(box[2] - box[0]) / 10}%`, width: `${(box[3] - box[1]) / 10}%`,
});

export const AnnotationOverlay = ({ annotations, selectedId, draft, interactive = false, labels, onSelect, onEdit }: AnnotationOverlayProps) => {
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
        const label = labels?.[annotation.id] ?? `Roof area ${index + 1}`;
        const status = annotation.validity === "needs_review" ? "Needs review" : annotation.review_status;
        const color = annotation.review_status === "accepted" ? "border-emerald-700 text-emerald-900"
          : annotation.review_status === "rejected" ? "border-gray-500 text-gray-700" : "border-sky-700 text-sky-900";
        const style = boxStyle(box);
        const className = `absolute border-2 ${color} ${annotation.review_status !== "accepted" ? "border-dashed" : ""}
          ${selected ? "ring-2 ring-white outline outline-2 outline-sky-900 z-10" : ""}`;
        return (
          <div key={annotation.id} className={className} style={style} data-testid={`annotation-box-${annotation.id}`}
            data-box={JSON.stringify(box)} data-status={annotation.review_status}>
            {interactive ? (
              <button type="button" data-annotation-id={annotation.id} aria-label={`${label}: ${status}`} aria-pressed={selected}
                title={`${label}: ${annotation.label} (${status})`}
                className="absolute inset-0 w-full h-full pointer-events-auto cursor-move focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
                onClick={() => onSelect?.(annotation.id)} onKeyDown={(event) => keyboardEdit(event, annotation, "move")} />
            ) : null}
            <span className="absolute top-0 whitespace-nowrap bg-white/95 px-1 text-xs font-semibold leading-5"
              style={box[1] > 500 ? { right: 0 } : { left: 0 }} title={`${label}: ${status}`}>
              {label}
            </span>
            {interactive && selected && (["nw", "ne", "sw", "se"] as const).map((handle) => (
              <button key={handle} type="button" aria-label={`Resize ${label} ${handle}`} title={`Resize ${label} ${handle}`}
                data-annotation-id={annotation.id} data-handle={handle}
                className="absolute w-3 h-3 bg-white border-2 border-sky-800 pointer-events-auto focus-visible:ring-2 focus-visible:ring-primary"
                style={{ top: handle.includes("n") ? -6 : undefined, bottom: handle.includes("s") ? -6 : undefined,
                  left: handle.includes("w") ? -6 : undefined, right: handle.includes("e") ? -6 : undefined,
                  cursor: handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize" }}
                onKeyDown={(event) => keyboardEdit(event, annotation, handle)} />
            ))}
          </div>
        );
      })}
      {draft?.id === "new" && <div className="absolute border-2 border-dashed border-sky-700 bg-sky-100/20" style={boxStyle(draft.box)} />}
    </div>
  );
};