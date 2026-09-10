import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Hand, Maximize, MousePointer2, Plus, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Box2D, RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { drawnRoiBox, editRoiBox, type BoxHandle } from "@/utils/roiBoxEditing";
import { AnnotationOverlay } from "./AnnotationOverlay";

interface RoiReviewCanvasProps {
  pdfCanvas: HTMLCanvasElement;
  annotations: RoiAnnotation[];
  selectedId: string | null;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, box: Box2D) => void;
  onAdd: (box: Box2D) => void;
}

interface Gesture {
  id: string;
  start: Point;
  original: Box2D;
  handle: BoxHandle;
  client: Point;
  scroll: Point;
}

export const RoiReviewCanvas = ({ pdfCanvas, annotations, selectedId, adding, onAddingChange, onSelect, onEdit, onAdd }: RoiReviewCanvasProps) => {
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<{ id: string; box: Box2D } | null>(null);
  const scale = fit * zoom;

  useEffect(() => {
    canvas.current?.getContext("2d")?.drawImage(pdfCanvas, 0, 0);
    const resize = () => {
      if (!viewport.current) return;
      setFit(Math.max(0.01, Math.min((viewport.current.clientWidth - 32) / pdfCanvas.width,
        (viewport.current.clientHeight - 32) / pdfCanvas.height)));
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(viewport.current!);
    return () => observer.disconnect();
  }, [pdfCanvas]);

  const point = (event: PointerEvent): Point => {
    const bounds = frame.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1000, (event.clientX - bounds.left) / bounds.width * 1000)),
      y: Math.max(0, Math.min(1000, (event.clientY - bounds.top) / bounds.height * 1000)) };
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const start = point(event);
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-annotation-id]");
    const annotation = annotations.find((candidate) => candidate.id === target?.dataset.annotationId);
    const pan = panning && !adding;
    if (!adding && !pan && !annotation) return;
    event.preventDefault();
    if (annotation && !adding && !pan) {
      onSelect(annotation.id);
      target?.focus();
    }
    gesture.current = { id: adding ? "new" : pan ? "pan" : annotation!.id, start,
      original: annotation?.box_2d ?? [start.y, start.x, start.y, start.x], handle: (target?.dataset.handle as BoxHandle) ?? "move",
      client: { x: event.clientX, y: event.clientY }, scroll: { x: viewport.current!.scrollLeft, y: viewport.current!.scrollTop } };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const nextBox = (event: PointerEvent, active: Gesture) => {
    const current = point(event);
    return active.id === "new" ? drawnRoiBox(active.start, current)
      : editRoiBox(active.original, { x: current.x - active.start.x, y: current.y - active.start.y }, active.handle);
  };

  const clearGesture = () => { gesture.current = null; setDraft(null); };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active) return;
    if (active.id === "pan") {
      viewport.current!.scrollLeft = active.scroll.x - (event.clientX - active.client.x);
      viewport.current!.scrollTop = active.scroll.y - (event.clientY - active.client.y);
    } else setDraft({ id: active.id, box: nextBox(event, active) });
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (active && active.id !== "pan") {
      const box = nextBox(event, active);
      if (active.id === "new") {
        if (box[2] - box[0] >= 1 && box[3] - box[1] >= 1) onAdd(box);
      } else if (box.some((value, index) => value !== active.original[index])) onEdit(active.id, box);
    }
    clearGesture();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const tools = [
    { label: "Select regions", icon: MousePointer2, active: !adding && !panning, action: () => { onAddingChange(false); setPanning(false); } },
    { label: "Pan drawing", icon: Hand, active: !adding && panning, action: () => { onAddingChange(false); setPanning(true); } },
    { label: "Draw roof region", icon: Plus, active: adding, action: () => onAddingChange(!adding) },
  ];

  return (
    <section className="flex flex-col flex-1 min-h-0 min-w-0 gap-3" aria-label="Roof region review">
      <TooltipProvider delayDuration={200}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Region tools">
            {tools.map(({ label, icon: Icon, active, action }) => <Tooltip key={label}>
              <TooltipTrigger asChild><Button size="icon" variant={active ? "default" : "outline"} aria-label={label}
                aria-pressed={active} onClick={action}><Icon className="w-4 h-4" /></Button></TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>)}
          </div>
          {[
            { label: "Zoom out", icon: ZoomOut, action: () => setZoom((value) => Math.max(0.5, value / 1.25)) },
            { label: "Zoom in", icon: ZoomIn, action: () => setZoom((value) => Math.min(8, value * 1.25)) },
            { label: "Fit page", icon: Maximize, action: () => { setZoom(1); viewport.current?.scrollTo(0, 0); } },
          ].map(({ label, icon: Icon, action }) => <Tooltip key={label}>
            <TooltipTrigger asChild><Button size="icon" variant="outline" aria-label={label} onClick={action}>
              <Icon className="w-4 h-4" /></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent>
          </Tooltip>)}
          <output className="text-sm tabular-nums w-14">{Math.round(scale * 100)}%</output>
        </div>
      </TooltipProvider>
      <div ref={viewport} className="flex-1 min-h-0 overflow-auto bg-muted border border-border rounded" data-testid="roi-viewport">
        <div ref={frame} tabIndex={-1} className="relative mx-auto my-4 shrink-0 touch-none bg-white"
          style={{ width: pdfCanvas.width * scale, height: pdfCanvas.height * scale, cursor: adding ? "crosshair" : panning ? "grab" : undefined }}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
          onPointerCancel={clearGesture} onLostPointerCapture={clearGesture}
          onKeyDown={(event) => { if (event.key === "Escape") { clearGesture(); onAddingChange(false); } }}>
          <canvas ref={canvas} width={pdfCanvas.width} height={pdfCanvas.height} className="block w-full h-full"
            aria-label="Unannotated roof plan" data-testid="roi-source-canvas" />
          <AnnotationOverlay annotations={annotations} selectedId={selectedId} draft={draft} interactive={!adding && !panning}
            onSelect={onSelect} onEdit={onEdit} />
        </div>
      </div>
    </section>
  );
};