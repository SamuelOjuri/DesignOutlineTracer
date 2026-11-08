import { useCallback, useEffect, useLayoutEffect, useRef, useState, useId, type PointerEvent } from "react";
import { Hand, Maximize, MousePointer2, Plus, ZoomIn, ZoomOut, Spline, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Box2D, PageDrawing, PageSession, RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { drawnRoiBox, editRoiBox, type BoxHandle } from "@/utils/roiBoxEditing";
import { AnnotationOverlay } from "./AnnotationOverlay";
import { drawingWithPenetrations, penetrationFootprint } from "@/utils/penetrationOpenings";
import { OUTLINE_APPEARANCE } from "@/utils/outlineAppearance";
import { footprintBox, penetrationBoundary, rotateFootprint, transformFootprint, validPenetrationRing } from "@/utils/penetrationGeometry";
import { penetrationRotationDegrees, penetrationRotationHandle, type PenetrationRotationHandle } from "@/utils/penetrationRotation";
import { snapToVectors } from "@/utils/polylineRedraw";
import { PenetrationShapeOverlay } from "./PenetrationShapeOverlay";

interface RoiReviewCanvasProps {
  kind?: "roof_roi" | "penetration";
  contextAnnotations?: RoiAnnotation[];
  contextLabels?: Record<string, string>;
  drawing?: PageDrawing;
  page?: PageSession;
  pdfCanvas: HTMLCanvasElement;
  annotations: RoiAnnotation[];
  selectedId: string | null;
  adding: boolean;
  onAddingChange: (adding: boolean) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, box: Box2D) => void;
  onAdd: (box: Box2D) => void;
  onEditFootprint?: (id: string, points: Point[]) => void;
  onAddFootprint?: (points: Point[]) => void;
  onUndoReview?: () => void;
}

interface Gesture {
  id: string;
  start: Point;
  original: Box2D;
  handle: BoxHandle;
  client: Point;
  scroll: Point;
  footprint?: Point[];
  vertex?: number;
  pointerId: number;
  rotation?: PenetrationRotationHandle & { start: Point };
}

type DrawingShape = "rectangle" | "polygon" | "ellipse" | "circle";
interface ShapeDraft { id: string; box: Box2D; footprint?: Point[]; rotation?: PenetrationRotationHandle; degrees?: number }

function ellipsePoints(box: Box2D, size: { width: number; height: number }, circle: boolean): Point[] {
  const x = (box[1] + box[3]) * size.width / 2000, y = (box[0] + box[2]) * size.height / 2000;
  let rx = (box[3] - box[1]) * size.width / 2000, ry = (box[2] - box[0]) * size.height / 2000;
  if (circle) rx = ry = Math.min(rx, ry);
  return Array.from({ length: 48 }, (_, index) => ({
    x: x + rx * Math.cos(index * Math.PI / 24), y: y + ry * Math.sin(index * Math.PI / 24),
  }));
}

export const RoiReviewCanvas = ({ kind = "roof_roi", contextAnnotations = [], contextLabels, drawing, page,
  pdfCanvas, annotations, selectedId, adding, onAddingChange, onSelect, onEdit, onAdd,
  onEditFootprint, onAddFootprint, onUndoReview }: RoiReviewCanvasProps) => {
  const viewport = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const zoomTarget = useRef<Point | null>(null);
  const [fit, setFit] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [panning, setPanning] = useState(false);
  const [draft, setDraft] = useState<ShapeDraft | null>(null);
  const [drawingShape, setDrawingShape] = useState<DrawingShape>("rectangle");
  const [vertices, setVertices] = useState<Point[]>([]);
  const [traceCursor, setTraceCursor] = useState<Point | null>(null);
  const [editVertices, setEditVertices] = useState(false);
  const [geometryError, setGeometryError] = useState<string | null>(null);
  const scale = fit * zoom;
  const size = { width: pdfCanvas.width, height: pdfCanvas.height };
  const maskId = useId();
  const validDraft = draft && (!draft.footprint || validPenetrationRing(draft.footprint, size)) ? draft : null;
  const previewPage = page && validDraft ? { ...page, annotations: page.annotations.map(annotation => annotation.id === validDraft.id
    ? { ...annotation, box_2d: validDraft.box, ...(validDraft.footprint ? { footprint: validDraft.footprint } : {}) } : annotation) } : page;
  const displayedDrawing = previewPage ? drawingWithPenetrations(previewPage) : drawing;
  const previewAnnotations = annotations.map(annotation => annotation.id === validDraft?.id
    ? { ...annotation, box_2d: validDraft.box, ...(validDraft.footprint ? { footprint: validDraft.footprint } : {}) } : annotation);
  const labels = Object.fromEntries(annotations.map((annotation, index) => [annotation.id, `${kind === "penetration" ? "Penetration" : "Roof area"} ${index + 1}`]));
  const shapeAnnotations = kind === "penetration" ? previewAnnotations.filter(annotation => annotation.footprint
    || (editVertices && annotation.id === selectedId)) : [];
  const shapeIds = new Set(shapeAnnotations.map(annotation => annotation.id));
  const selectedAnnotation = previewAnnotations.find(annotation => annotation.id === selectedId);
  const selectedPreview = kind === "penetration" && previewPage && selectedAnnotation
    && (selectedAnnotation.review_status !== "accepted" || selectedAnnotation.validity !== "current")
    ? penetrationFootprint(selectedAnnotation, previewPage) : null;
  // An opening is already stroked below. Drawing its editable rectangle as well
  // thickens the line and can show an unclipped box outside the insulation scope.
  const openingIds = new Set(displayedDrawing?.holes.map(hole => hole.id));
  const boundaryRenderedIds = new Set(annotations.filter(annotation => annotation.kind === "penetration"
    && annotation.review_status === "accepted" && annotation.validity === "current"
    && openingIds.has(`penetration:${annotation.id}:0`)).map(annotation => annotation.id));

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

  const centerPenetration = useCallback((target: Point, displayScale: number) => {
    const container = viewport.current, drawing = frame.current;
    if (!container || !drawing) return;
    const containerBounds = container.getBoundingClientRect(), drawingBounds = drawing.getBoundingClientRect();
    // Rect differences account for page centering, borders and an already scrolled viewport.
    container.scrollLeft = Math.max(0, container.scrollLeft + drawingBounds.left - containerBounds.left
      - container.clientLeft + target.x * displayScale - container.clientWidth / 2);
    container.scrollTop = Math.max(0, container.scrollTop + drawingBounds.top - containerBounds.top
      - container.clientTop + target.y * displayScale - container.clientHeight / 2);
  }, []);

  useLayoutEffect(() => {
    if (!zoomTarget.current) return;
    centerPenetration(zoomTarget.current, scale);
    zoomTarget.current = null;
  }, [scale, centerPenetration]);

  useEffect(() => {
    if (!adding) { setVertices([]); setTraceCursor(null); }
    setGeometryError(null);
  }, [adding, pdfCanvas]);

  const clearTrace = useCallback(() => { setVertices([]); setTraceCursor(null); setGeometryError(null); }, []);
  const addBoundary = (points: Point[]) => {
    if (!validPenetrationRing(points, size)) {
      setGeometryError("Use at least three distinct corners and a boundary that does not cross itself or leave the page.");
      return false;
    }
    if (onAddFootprint) onAddFootprint(points);
    else onAdd(footprintBox(points, size));
    clearTrace();
    return true;
  };
  const finishTrace = () => addBoundary(vertices);

  const point = (event: PointerEvent): Point => {
    const bounds = frame.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1000, (event.clientX - bounds.left) / bounds.width * 1000)),
      y: Math.max(0, Math.min(1000, (event.clientY - bounds.top) / bounds.height * 1000)) };
  };
  const sourcePoint = (event: PointerEvent, snap = true): Point => {
    const normalized = point(event);
    const raw = { x: normalized.x * size.width / 1000, y: normalized.y * size.height / 1000 };
    return snap && !event.altKey ? snapToVectors(raw, page?.source.vector_segments ?? [], 8 / Math.max(scale, 0.0001))?.point ?? raw : raw;
  };
  const rawSourcePoint = (event: PointerEvent): Point => {
    const bounds = frame.current!.getBoundingClientRect();
    return { x: (event.clientX - bounds.left) * size.width / bounds.width,
      y: (event.clientY - bounds.top) * size.height / bounds.height };
  };

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (kind === "penetration" && adding && drawingShape === "polygon") {
      event.preventDefault(); event.currentTarget.focus();
      const corner = sourcePoint(event);
      if (vertices.length >= 3 && Math.hypot(corner.x - vertices[0].x, corner.y - vertices[0].y) * scale <= 8) finishTrace();
      else if (vertices.length < 128 && (!vertices.length || Math.hypot(corner.x - vertices[vertices.length - 1].x,
        corner.y - vertices[vertices.length - 1].y) > 0.001)) {
        setVertices(current => [...current, corner]); setGeometryError(null);
      }
      return;
    }
    const start = point(event);
    const target = (event.target as Element).closest<HTMLElement>("[data-annotation-id]");
    const annotation = annotations.find((candidate) => candidate.id === target?.dataset.annotationId);
    const pan = panning && !adding;
    if (!adding && !pan && !annotation) return;
    event.preventDefault();
    if (annotation && !adding && !pan) {
      onSelect(annotation.id);
      target?.focus();
    } else event.currentTarget.focus();
    const rotating = !adding && !pan && kind === "penetration" && onEditFootprint && target?.dataset.rotationHandle === "true";
    const footprint = annotation && kind === "penetration" && (annotation.footprint || target?.dataset.vertexIndex !== undefined || rotating)
      ? penetrationBoundary(annotation, size) : undefined;
    gesture.current = { id: adding ? "new" : pan ? "pan" : annotation!.id, start, pointerId: event.pointerId,
      original: annotation?.box_2d ?? [start.y, start.x, start.y, start.x], handle: (target?.dataset.handle as BoxHandle) ?? "move",
      client: { x: event.clientX, y: event.clientY }, scroll: { x: viewport.current!.scrollLeft, y: viewport.current!.scrollTop },
      footprint,
      ...(rotating && footprint ? { rotation: { ...penetrationRotationHandle(footprint, size, scale), start: rawSourcePoint(event) } } : {}),
      vertex: target?.dataset.vertexIndex === undefined ? undefined : Number(target.dataset.vertexIndex) };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const nextBox = (event: PointerEvent, active: Gesture) => {
    const current = point(event);
    return active.id === "new" ? drawnRoiBox(active.start, current)
      : editRoiBox(active.original, { x: current.x - active.start.x, y: current.y - active.start.y }, active.handle);
  };
  const nextDraft = (event: PointerEvent, active: Gesture): ShapeDraft => {
    if (active.rotation && active.footprint) {
      const { center, anchor, handle, start } = active.rotation;
      const degrees = penetrationRotationDegrees(center, start, rawSourcePoint(event), event.shiftKey);
      // Always rotate the original ring around the captured pivot; concave previews must not drift.
      const footprint = rotateFootprint(active.footprint, degrees, center);
      const [nextAnchor, nextHandle] = rotateFootprint([anchor, handle], degrees, center);
      return { id: active.id, footprint, degrees,
        box: validPenetrationRing(footprint, size) ? footprintBox(footprint, size) : active.original,
        rotation: { center, anchor: nextAnchor, handle: nextHandle } };
    }
    const box = nextBox(event, active);
    if (active.footprint && active.vertex !== undefined) {
      const current = sourcePoint(event, false), original = active.footprint[active.vertex];
      const moved = { x: Math.max(0, Math.min(size.width, original.x + current.x - active.start.x * size.width / 1000)),
        y: Math.max(0, Math.min(size.height, original.y + current.y - active.start.y * size.height / 1000)) };
      const snapped = event.altKey ? moved : snapToVectors(moved, page?.source.vector_segments ?? [], 8 / Math.max(scale, 0.0001))?.point ?? moved;
      const next = active.footprint.map((point, index) => index === active.vertex ? snapped : point);
      return { id: active.id, box: validPenetrationRing(next, size) ? footprintBox(next, size) : active.original, footprint: next };
    }
    const footprint = active.footprint ? transformFootprint(active.footprint, active.original, box, size)
      : active.id === "new" && kind === "penetration" && (drawingShape === "ellipse" || drawingShape === "circle")
        ? ellipsePoints(box, size, drawingShape === "circle") : undefined;
    return { id: active.id, box, ...(footprint ? { footprint } : {}) };
  };

  const clearGesture = useCallback(() => {
    const active = gesture.current;
    gesture.current = null; setDraft(null);
    if (active && frame.current?.hasPointerCapture?.(active.pointerId)) frame.current.releasePointerCapture(active.pointerId);
  }, []);
  const annotationGeometry = JSON.stringify(annotations.map(annotation => [annotation.id, annotation.revision,
    annotation.box_2d, annotation.footprint, annotation.review_status, annotation.validity]));
  useEffect(() => {
    clearGesture(); clearTrace();
  }, [pdfCanvas, page?.geometry_revision, annotationGeometry, clearGesture, clearTrace]);
  useEffect(() => {
    if (gesture.current && gesture.current.id !== selectedId) clearGesture();
    clearTrace();
  }, [selectedId, clearGesture, clearTrace]);
  useEffect(() => {
    const blur = () => { clearGesture(); clearTrace(); };
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("blur", blur); clearGesture(); };
  }, [clearGesture, clearTrace]);
  const transformMoved = (event: PointerEvent, active: Gesture) => active.vertex === undefined && !active.rotation
    || Math.hypot(event.clientX - active.client.x, event.clientY - active.client.y) >= 3;
  const invalidTransformMessage = (active: Gesture) => active.rotation
    ? "The rotated boundary would leave the page. Rotate it back inside before releasing."
    : "This edit would cross the boundary or collapse the opening. Move the vertex to another position.";
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (kind === "penetration" && adding && drawingShape === "polygon") setTraceCursor(sourcePoint(event));
    if (!active) return;
    if (!transformMoved(event, active)) { setDraft(null); setGeometryError(null); return; }
    if (active.id === "pan") {
      viewport.current!.scrollLeft = active.scroll.x - (event.clientX - active.client.x);
      viewport.current!.scrollTop = active.scroll.y - (event.clientY - active.client.y);
    } else {
      const next = nextDraft(event, active);
      setDraft(next);
      setGeometryError(next.footprint && !validPenetrationRing(next.footprint, size)
        ? invalidTransformMessage(active) : null);
    }
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (active && active.id !== "pan" && transformMoved(event, active)) {
      const { box, footprint } = nextDraft(event, active);
      if (active.id === "new") {
        if (box[2] - box[0] >= 1 && box[3] - box[1] >= 1) {
          if (footprint) addBoundary(footprint);
          else if (kind === "penetration" && onAddFootprint) addBoundary(penetrationBoundary({ box_2d: box }, size));
          else onAdd(box);
        }
      } else if (footprint) {
        if (!validPenetrationRing(footprint, size)) setGeometryError(invalidTransformMessage(active));
        else if (active.rotation ? footprint.some((point, index) => Math.hypot(point.x - active.footprint![index].x,
          point.y - active.footprint![index].y) > 1e-6) : JSON.stringify(footprint) !== JSON.stringify(active.footprint)) {
          onEditFootprint?.(active.id, footprint); setGeometryError(null);
        }
      } else if (box.some((value, index) => value !== active.original[index])) onEdit(active.id, box);
    }
    clearGesture();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleZoomToPenetration = () => {
    const container = viewport.current;
    if (!selectedAnnotation || !container) return;
    const boundary = penetrationBoundary(selectedAnnotation, size);
    if (!validPenetrationRing(boundary, size)) return;
    const left = Math.min(...boundary.map(point => point.x)), right = Math.max(...boundary.map(point => point.x));
    const top = Math.min(...boundary.map(point => point.y)), bottom = Math.max(...boundary.map(point => point.y));
    const target = { x: (left + right) / 2, y: (top + bottom) / 2 };
    // Show small objects in detail while retaining space around the complete opening.
    const targetScale = Math.min(Math.min(320, Math.max(1, container.clientWidth * 0.7)) / (right - left),
      Math.min(320, Math.max(1, container.clientHeight * 0.7)) / (bottom - top));
    const nextZoom = Math.max(1, Math.min(8, targetScale / fit));
    clearGesture();
    if (nextZoom === zoom) centerPenetration(target, scale);
    else { zoomTarget.current = target; setZoom(nextZoom); }
  };

  const tools = [
    { label: kind === "penetration" ? "Select penetrations" : "Select regions", icon: MousePointer2, active: !adding && !panning, action: () => { onAddingChange(false); setPanning(false); clearTrace(); } },
    { label: "Pan drawing", icon: Hand, active: !adding && panning, action: () => { onAddingChange(false); setPanning(true); clearTrace(); } },
    { label: kind === "penetration" ? "Draw penetration" : "Draw roof region", icon: Plus, active: adding, action: () => onAddingChange(!adding) },
  ];

  return (
    <section className="flex flex-col flex-1 min-h-0 min-w-0 gap-3" aria-label={kind === "penetration" ? "Penetration review" : "Roof region review"}>
      <TooltipProvider delayDuration={200}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1" role="group" aria-label={kind === "penetration" ? "Penetration tools" : "Region tools"}>
            {tools.map(({ label, icon: Icon, active, action }) => <Tooltip key={label}>
              <TooltipTrigger asChild><Button size="icon" variant={active ? "default" : "outline"} aria-label={label}
                aria-pressed={active} onClick={action}><Icon className="w-4 h-4" /></Button></TooltipTrigger>
              <TooltipContent>{label}</TooltipContent>
            </Tooltip>)}
            {kind === "penetration" && <Tooltip>
              <TooltipTrigger asChild><Button size="icon" variant="outline" aria-label="Undo review edit"
                disabled={!page?.history.length || !onUndoReview} onClick={() => {
                  clearGesture(); clearTrace(); onUndoReview?.();
                }}><Undo2 className="w-4 h-4" /></Button></TooltipTrigger>
              <TooltipContent>Undo review edit</TooltipContent>
            </Tooltip>}
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
          {kind === "penetration" && selectedAnnotation && <Button variant="outline" size="sm"
            disabled={adding} onClick={handleZoomToPenetration}>Zoom to Penetration</Button>}
          {kind === "penetration" && <>
            <label className="text-sm flex items-center gap-2">Opening shape
              <select aria-label="Opening shape" value={drawingShape} className="h-10 rounded-md border border-input bg-background px-2"
                onChange={event => { setDrawingShape(event.target.value as DrawingShape); clearTrace(); clearGesture(); }}>
                <option value="rectangle">Rectangle</option><option value="polygon" disabled={!onAddFootprint}>Polygon</option>
                <option value="ellipse" disabled={!onAddFootprint}>Ellipse</option><option value="circle" disabled={!onAddFootprint}>Circle</option>
              </select>
            </label>
            <Button variant={editVertices ? "default" : "outline"} aria-pressed={editVertices}
              disabled={!selectedId || adding || panning || !onEditFootprint} onClick={() => setEditVertices(value => !value)}>
              <Spline className="w-4 h-4 mr-2" />Edit vertices</Button>
          </>}
        </div>
      </TooltipProvider>
      {kind === "penetration" && <p className="text-sm text-muted-foreground">
        {adding ? drawingShape === "polygon" ? "Click each corner, then Finish polygon or click the first corner. Hold Alt for a free point."
          : `Drag around the ${drawingShape}, then select Add opening.`
          : editVertices ? "Click a square corner to select it in red; drag or use arrow keys to move it, Delete to remove it. Round handles add vertices. Drag the rotation handle to rotate; Shift snaps by 15 degrees. Alt disables PDF snapping."
            : "Select a penetration and Add opening to cut it out. Drag its boundary to move, corners to resize, or the rotation handle to rotate. Shift snaps rotation by 15 degrees."}
      </p>}
      {kind === "penetration" && adding && drawingShape === "polygon" && <div className="flex flex-wrap gap-2 items-center">
        <Button size="sm" onClick={finishTrace} disabled={vertices.length < 3}>Finish polygon</Button>
        <Button size="sm" variant="outline" disabled={!vertices.length} onClick={() => setVertices(current => current.slice(0, -1))}>Undo last corner</Button>
        <Button size="sm" variant="outline" onClick={() => { clearTrace(); onAddingChange(false); }}>Cancel polygon</Button>
        <span className="text-xs text-muted-foreground">{vertices.length} corners / Enter finishes / Escape cancels</span>
      </div>}
      {geometryError && <p role="alert" className="text-sm text-destructive">{geometryError}</p>}
      <div ref={viewport} className="flex-1 min-h-0 overflow-auto bg-muted border border-border rounded" data-testid="roi-viewport">
        <div ref={frame} tabIndex={-1} className="relative mx-auto my-4 shrink-0 touch-none bg-white"
          style={{ width: pdfCanvas.width * scale, height: pdfCanvas.height * scale, cursor: adding ? "crosshair" : panning ? "grab" : undefined }}
          onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
          onPointerCancel={clearGesture} onLostPointerCapture={clearGesture}
          onKeyDown={(event) => {
            if (event.key === "Escape") { clearGesture(); clearTrace(); onAddingChange(false); }
            else if (adding && drawingShape === "polygon" && event.key === "Enter") { event.preventDefault(); finishTrace(); }
            else if (adding && drawingShape === "polygon" && event.key === "Backspace") {
              event.preventDefault(); setVertices(current => current.slice(0, -1));
            }
          }}>
          <canvas ref={canvas} width={pdfCanvas.width} height={pdfCanvas.height} className="block w-full h-full"
            aria-label="Unannotated roof plan" data-testid="roi-source-canvas" />
          {displayedDrawing && <svg viewBox={`0 0 ${pdfCanvas.width} ${pdfCanvas.height}`} preserveAspectRatio="none"
            aria-label="Manual roof geometry" className="absolute inset-0 w-full h-full pointer-events-none">
            <defs><mask id={maskId} maskUnits="userSpaceOnUse" x={0} y={0} width={pdfCanvas.width} height={pdfCanvas.height}>
              <rect width={pdfCanvas.width} height={pdfCanvas.height} fill="black" />
              {displayedDrawing.outlines.map(outline => <polygon key={outline.id}
                points={outline.points.map(point => `${point.x},${point.y}`).join(" ")} fill="white" />)}
              {displayedDrawing.holes.map(hole => <polygon key={hole.id} data-testid={`opening-mask-${hole.id}`}
                points={hole.points.map(point => `${point.x},${point.y}`).join(" ")} fill="black" />)}
            </mask></defs>
            <rect width={pdfCanvas.width} height={pdfCanvas.height} fill={OUTLINE_APPEARANCE.stroke}
              fillOpacity={OUTLINE_APPEARANCE.acceptedFillOpacity} mask={`url(#${maskId})`} />
            {displayedDrawing.outlines.map((outline) => <polygon key={outline.id} points={outline.points.map((point) => `${point.x},${point.y}`).join(" ")}
              fill="none" stroke={OUTLINE_APPEARANCE.stroke} strokeWidth={OUTLINE_APPEARANCE.strokeWidth} vectorEffect="non-scaling-stroke" />)}
            {displayedDrawing.holes.map((hole) => <polygon key={hole.id} points={hole.points.map((point) => `${point.x},${point.y}`).join(" ")}
              fill="none" stroke={OUTLINE_APPEARANCE.stroke} strokeWidth={OUTLINE_APPEARANCE.strokeWidth} vectorEffect="non-scaling-stroke" />)}
          </svg>}
          {contextAnnotations.length > 0 && <AnnotationOverlay annotations={contextAnnotations} labels={contextLabels} labelsAbove />}
          {selectedPreview?.clipped && <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full pointer-events-none" aria-label="Proposed clipped opening">
            {selectedPreview.openings.map(opening => <polygon key={opening.id} data-testid={`proposed-opening-${opening.id}`}
              mask={`url(#${maskId})`}
              points={opening.points.map(point => `${point.x},${point.y}`).join(" ")}
              fill="#f59e0b" fillOpacity={0.22} stroke="#b45309" strokeWidth={2}
              strokeDasharray="5 3" vectorEffect="non-scaling-stroke" />)}
          </svg>}
          <AnnotationOverlay annotations={previewAnnotations.filter(annotation => !shapeIds.has(annotation.id))} labels={labels}
            selectedId={selectedId} draft={draft?.footprint ? null : draft} draftKind={kind} interactive={!adding && !panning}
            boundaryRenderedIds={boundaryRenderedIds} onSelect={onSelect} onEdit={onEdit} />
          {kind === "penetration" && <PenetrationShapeOverlay annotations={shapeAnnotations} labels={labels} size={size}
            selectedId={selectedId} interactive={!adding && !panning} editVertices={editVertices}
            scale={scale} rotationAnnotation={selectedAnnotation} rotationPreview={validDraft?.rotation}
            boundaryRenderedIds={boundaryRenderedIds} onSelect={onSelect} onEditBox={onEdit} onEditFootprint={onEditFootprint} />}
          {kind === "penetration" && (vertices.length > 0 || draft?.footprint && (draft.id === "new" || !validDraft)) && <svg
            viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full pointer-events-none" aria-label="Draft penetration boundary">
            {draft?.footprint && (draft.id === "new" || !validDraft) ? <polygon points={draft.footprint.map(point => `${point.x},${point.y}`).join(" ")}
              fill={validDraft ? OUTLINE_APPEARANCE.stroke : "#dc2626"} fillOpacity={0.08}
              stroke={validDraft ? OUTLINE_APPEARANCE.stroke : "#dc2626"} strokeWidth={2}
              strokeDasharray="6 4" vectorEffect="non-scaling-stroke" /> : <>
              <polyline points={[...vertices, ...(traceCursor ? [traceCursor] : [])].map(point => `${point.x},${point.y}`).join(" ")}
                fill="none" stroke={OUTLINE_APPEARANCE.stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />
              {vertices.map((point, index) => <circle key={index} cx={point.x} cy={point.y} r={4 / Math.max(scale, 0.0001)}
                fill="white" stroke={OUTLINE_APPEARANCE.stroke} strokeWidth={2} vectorEffect="non-scaling-stroke" />)}
            </>}
          </svg>}
        </div>
      </div>
    </section>
  );
};
