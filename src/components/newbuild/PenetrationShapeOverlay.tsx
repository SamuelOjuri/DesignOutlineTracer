import { useRef, type KeyboardEvent } from "react";
import { RotateCw } from "lucide-react";
import type { Box2D, RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { penetrationBoundary, footprintBox, rotateFootprint, validPenetrationRing } from "@/utils/penetrationGeometry";
import { penetrationRotationHandle, type PenetrationRotationHandle } from "@/utils/penetrationRotation";
import { editRoiBox, type BoxHandle } from "@/utils/roiBoxEditing";
import { OUTLINE_APPEARANCE } from "@/utils/outlineAppearance";

interface PenetrationShapeOverlayProps {
  annotations: RoiAnnotation[];
  labels: Record<string, string>;
  size: { width: number; height: number };
  selectedId: string | null;
  interactive: boolean;
  editVertices: boolean;
  boundaryRenderedIds: ReadonlySet<string>;
  onSelect: (id: string) => void;
  onEditBox: (id: string, box: Box2D) => void;
  onEditFootprint?: (id: string, points: Point[]) => void;
  rotationAnnotation?: RoiAnnotation;
  rotationPreview?: PenetrationRotationHandle;
  scale?: number;
}

/** The polygon is both the visible boundary and the hit target; its box is only a resize guide. */
export function PenetrationShapeOverlay({ annotations, labels, size, selectedId, interactive, editVertices,
  boundaryRenderedIds, onSelect, onEditBox, onEditFootprint, rotationAnnotation, rotationPreview, scale = 1 }: PenetrationShapeOverlayProps) {
  const rotating = interactive && onEditFootprint ? rotationAnnotation : undefined;
  const rotation = rotating ? rotationPreview ?? penetrationRotationHandle(penetrationBoundary(rotating, size), size, scale) : null;
  const keyboardRotation = useRef<{ id: string; center: Point; signature: string } | null>(null);
  const keyboard = (event: KeyboardEvent, annotation: RoiAnnotation, vertex?: number, handle: BoxHandle = "move") => {
    const points = penetrationBoundary(annotation, size);
    if (vertex !== undefined && (event.key === "Delete" || event.key === "Backspace")) {
      event.preventDefault(); event.stopPropagation();
      const next = points.filter((_, index) => index !== vertex);
      if (validPenetrationRing(next, size)) onEditFootprint?.(annotation.id, next);
      return;
    }
    const amount = event.shiftKey ? 10 : 1;
    const delta = ({ ArrowLeft: { x: -amount, y: 0 }, ArrowRight: { x: amount, y: 0 },
      ArrowUp: { x: 0, y: -amount }, ArrowDown: { x: 0, y: amount } })[event.key];
    if (!delta) return;
    event.preventDefault(); event.stopPropagation();
    if (vertex !== undefined) {
      const next = points.map((point, index) => index === vertex
        ? { x: Math.max(0, Math.min(size.width, point.x + delta.x)), y: Math.max(0, Math.min(size.height, point.y + delta.y)) } : point);
      if (validPenetrationRing(next, size)) onEditFootprint?.(annotation.id, next);
    } else onEditBox(annotation.id, editRoiBox(footprintBox(points, size), {
      x: delta.x * 1000 / size.width, y: delta.y * 1000 / size.height,
    }, handle));
  };
  const at = (point: Point) => ({ left: `${point.x / size.width * 100}%`, top: `${point.y / size.height * 100}%` });

  return <div className="absolute inset-0 pointer-events-none" data-testid="penetration-shape-overlay">
    <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full overflow-visible" aria-label="Penetration boundaries">
      {annotations.map(annotation => {
        const points = penetrationBoundary(annotation, size);
        const selected = annotation.id === selectedId;
        const status = annotation.validity === "needs_review" ? "Needs review" : annotation.review_status;
        const color = annotation.review_status === "rejected" ? "#6b7280" : OUTLINE_APPEARANCE.stroke;
        return <polygon key={annotation.id} points={points.map(point => `${point.x},${point.y}`).join(" ")}
          data-testid={`penetration-shape-${annotation.id}`} data-annotation-id={annotation.id}
          fill={selected ? color : "transparent"} fillOpacity={selected ? 0.07 : 0}
          stroke={boundaryRenderedIds.has(annotation.id) ? "none" : color} strokeWidth={2}
          strokeDasharray={annotation.review_status === "accepted" ? undefined : "6 4"} vectorEffect="non-scaling-stroke"
          role={interactive ? "button" : undefined} tabIndex={interactive ? 0 : undefined}
          aria-label={`${labels[annotation.id]}: ${status}`} aria-pressed={selected}
          className={interactive ? "pointer-events-auto cursor-move focus-visible:outline focus-visible:outline-2" : undefined}
          onClick={() => interactive && onSelect(annotation.id)}
          onKeyDown={event => {
            if (interactive && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onSelect(annotation.id); }
            else if (interactive) keyboard(event, annotation);
          }}><title>{`${labels[annotation.id]}: ${annotation.label}`}</title></polygon>;
      })}
      {rotation && <line x1={rotation.anchor.x} y1={rotation.anchor.y} x2={rotation.handle.x} y2={rotation.handle.y}
        stroke={OUTLINE_APPEARANCE.stroke} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />}
    </svg>
    {rotating && rotation && <button type="button" data-annotation-id={rotating.id} data-rotation-handle="true"
      aria-label={`Rotate ${labels[rotating.id]}`} title="Drag to rotate. Hold Shift to snap by 15 degrees. Arrow keys rotate; Shift rotates by 15 degrees."
      className="absolute w-6 h-6 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-800 bg-white text-sky-800 pointer-events-auto cursor-grab active:cursor-grabbing flex items-center justify-center focus-visible:ring-2 focus-visible:ring-primary"
      style={at(rotation.handle)} onBlur={() => { keyboardRotation.current = null; }} onKeyDown={event => {
        const direction = ({ ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 })[event.key];
        if (!direction) return;
        event.preventDefault(); event.stopPropagation();
        const original = penetrationBoundary(rotating, size), previous = keyboardRotation.current;
        const center = previous?.id === rotating.id && previous.signature === JSON.stringify(original) ? previous.center : rotation.center;
        const next = rotateFootprint(original, direction * (event.shiftKey ? 15 : 1), center);
        if (validPenetrationRing(next, size)) {
          keyboardRotation.current = { id: rotating.id, center, signature: JSON.stringify(next) };
          onEditFootprint?.(rotating.id, next);
        }
      }}><RotateCw className="w-3.5 h-3.5" aria-hidden="true" /></button>}
    {annotations.map(annotation => {
      const points = penetrationBoundary(annotation, size);
      const box = footprintBox(points, size);
      const selected = annotation.id === selectedId;
      const label = labels[annotation.id];
      return <div key={annotation.id}>
        <span className="absolute bg-white/95 px-1 text-xs font-semibold leading-5 text-sky-800 whitespace-nowrap"
          style={{ top: `${box[0] / 10}%`, ...(box[3] < 900 ? { left: `calc(${box[3] / 10}% + 8px)` }
            : { right: `calc(${100 - box[1] / 10}% + 8px)` }) }}>{label.replace("Penetration ", "P")}</span>
        {interactive && selected && !editVertices && (["nw", "ne", "sw", "se"] as const).map(handle => <button
          key={handle} type="button" data-annotation-id={annotation.id} data-handle={handle}
          aria-label={`Resize ${label} ${handle}`} title={`Resize ${label} ${handle}`}
          className="absolute w-3 h-3 -translate-x-1/2 -translate-y-1/2 border-2 border-sky-800 bg-white pointer-events-auto focus-visible:ring-2 focus-visible:ring-primary"
          style={{ left: `${box[handle.includes("w") ? 1 : 3] / 10}%`, top: `${box[handle.includes("n") ? 0 : 2] / 10}%`,
            cursor: handle === "nw" || handle === "se" ? "nwse-resize" : "nesw-resize" }}
          onKeyDown={event => keyboard(event, annotation, undefined, handle)} />)}
        {interactive && selected && editVertices && points.map((point, index) => <div key={index}>
          <button type="button" data-annotation-id={annotation.id} data-vertex-index={index}
            aria-label={`Move ${label} vertex ${index + 1}`} title="Click to select this vertex in red. Drag or use arrow keys to move; Delete removes. Hold Alt to disable snapping."
            className="absolute z-20 w-3 h-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border-2 border-sky-800 bg-white pointer-events-auto cursor-move focus:z-30 focus:border-white focus:bg-primary focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-white"
            style={at(point)} onKeyDown={event => keyboard(event, annotation, index)} />
          {points.length < 128 && <button type="button" aria-label={`Add ${label} vertex after ${index + 1}`}
            title="Add vertex on this edge"
            className="absolute z-10 w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-sky-800 bg-sky-100 pointer-events-auto focus-visible:ring-2 focus-visible:ring-primary"
            style={at({ x: (point.x + points[(index + 1) % points.length].x) / 2, y: (point.y + points[(index + 1) % points.length].y) / 2 })}
            onPointerDown={event => event.stopPropagation()}
            onClick={event => {
              event.stopPropagation();
              const next = [...points.slice(0, index + 1), { x: (point.x + points[(index + 1) % points.length].x) / 2,
                y: (point.y + points[(index + 1) % points.length].y) / 2 }, ...points.slice(index + 1)];
              if (validPenetrationRing(next, size)) onEditFootprint?.(annotation.id, next);
            }} />}
        </div>)}
      </div>;
    })}
  </div>;
}
