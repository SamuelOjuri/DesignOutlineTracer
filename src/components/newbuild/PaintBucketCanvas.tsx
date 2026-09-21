import { useRef, useEffect, useState, useCallback, useId } from "react";
import { Point } from "@/types/roof";
import { floodFill, floodFillPreview, eraseFill, extractMultipleOutlines, extractInteriorHoles, buildEdgeMap, buildRegionMap } from "@/utils/floodFill";
import { findClosestEdge, findClosestVertex, findVertexMergeTarget, mergePolygonVertex, movePolygonEdge, prepareEdgeEdit, prepareOutlineEdit, rasterizeOutlinesWithHoles, straightenPolygonSide, type OutlineEditResult } from "@/utils/polygonAdjust";
import { Button } from "@/components/ui/button";
import type { Box2D, RoiAnnotation } from "@/types/roi";
import { buildRoiFillMask } from "@/utils/roiFillMask";
import { cutoutRectangle, subtractRectangles, type CutoutRectangle } from "@/utils/rectangleCutout";
import { AnnotationOverlay } from "./AnnotationOverlay";
import { ZoomIn, ZoomOut, Maximize, Undo2, RotateCcw, MousePointer, PaintBucket, Scissors, Move, Loader2, RectangleHorizontal, Ruler } from "lucide-react";

type PaintTool = "fill" | "cutout" | "rectangle-cutout" | "adjust" | "straighten";

interface SelectionSnapshot {
  mask: Uint8Array | null;
  cutoutMask: Uint8Array | null;
  rectangles: CutoutRectangle[];
  outlines: Point[][];
  holes: Point[][];
}

interface PaintBucketCanvasProps {
  pdfCanvas: HTMLCanvasElement;
  onOutlinesExtracted: (outlines: Point[][], editedOutlineIndex?: number) => void;
  onHolesExtracted?: (holes: Point[][]) => void;
  roofOutlines: Point[][];
  interiorHoles?: Point[][];
  acceptedRegions?: RoiAnnotation[];
  regionLabels?: Record<string, string>;
}

const FILL_COLOR: [number, number, number, number] = [220, 50, 50, 160];
const PREVIEW_FILL_COLOR = [50, 130, 220, 100] as const;
const PREVIEW_REMOVE_COLOR = [220, 50, 50, 80] as const;
const PREVIEW_CUTOUT_COLOR = [255, 140, 0, 100] as const;
const DEFAULT_CUTOUT_SENSITIVITY = 40;
const DEFAULT_SELECTION_SENSITIVITY = 45;

export const PaintBucketCanvas = ({
  pdfCanvas,
  onOutlinesExtracted,
  onHolesExtracted,
  roofOutlines,
  interiorHoles = [],
  acceptedRegions = [],
  regionLabels,
}: PaintBucketCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [fillCount, setFillCount] = useState(0);
  const [activeTool, setActiveTool] = useState<PaintTool>("fill");
  const [cutoutSensitivity, setCutoutSensitivity] = useState(DEFAULT_CUTOUT_SENSITIVITY);
  const cutoutSensitivityId = useId();
  const [selectionSensitivity, setSelectionSensitivity] = useState(DEFAULT_SELECTION_SENSITIVITY);
  const selectionSensitivityId = useId();
  const [isInitializing, setIsInitializing] = useState(true);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  // The parent recreates annotation arrays on drawing updates; only changed boxes should rebuild the mask.
  const regionBoxesKey = JSON.stringify(acceptedRegions.map((region) => region.box_2d));
  const allowedMaskRef = useRef<Uint8Array | undefined>(undefined);

  const originalImageDataRef = useRef<ImageData | null>(null);
  const filledMaskRef = useRef<Uint8Array | null>(null);
  const maskHistoryRef = useRef<SelectionSnapshot[]>([]);
  const cachedEdgeMapRef = useRef<Uint8Array | null>(null);
  const cutoutMaskRef = useRef<Uint8Array | null>(null);
  const rectangleCutsRef = useRef<CutoutRectangle[]>([]);
  const rectangleDragRef = useRef<{ start: Point; end: Point; pointerId: number; mask: Uint8Array } | null>(null);
  const rectangleFrameRef = useRef<number | null>(null);
  const regionLabelsRef = useRef<Int32Array | null>(null);
  const regionSeedsRef = useRef<Map<number, { x: number; y: number }> | null>(null);
  const regionSensitivityRef = useRef<number | null>(null);

  // Hover preview refs
  const hoverTimerRef = useRef<number | null>(null);
  const lastPreviewPosRef = useRef<{ x: number; y: number } | null>(null);
  const previewMaskRef = useRef<Uint8Array | null>(null);
  const isComputingRef = useRef(false);

  // Rectangle drag refs
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const dragCurrentRef = useRef<{ x: number; y: number } | null>(null);
  const dragMaskBeforeRef = useRef<Uint8Array | null>(null);
  const justDraggedRef = useRef(false);

  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRafRef = useRef<number | null>(null);

  // Adjust tool state
  const [hoveredEdge, setHoveredEdge] = useState<{ outlineIndex: number; edgeIndex: number } | null>(null);
  const [hoveredVertex, setHoveredVertex] = useState<{ outlineIndex: number; vertexIndex: number } | null>(null);
  const [adjustmentVersion, setAdjustmentVersion] = useState(0);
  const adjustDragRef = useRef<{
    type: "edge" | "vertex";
    outlineIndex: number;
    edgeIndex?: number;
    vertexIndex?: number;
    startX: number;
    startY: number;
    originalOutlines: Point[][];
    originalHoles: Point[][];
    pointerId: number;
    previewEdit: OutlineEditResult | null;
    previewMask: Uint8Array | null;
    mergeTarget: Point | null;
  } | null>(null);
  const interiorHolesRef = useRef<Point[][]>([]);
  const sourceGeometry = useRef({ roofOutlines, interiorHoles });

  useEffect(() => {
    sourceGeometry.current = { roofOutlines, interiorHoles };
  }, [roofOutlines, interiorHoles]);

  const saveHistory = useCallback((mask = filledMaskRef.current) => {
    maskHistoryRef.current.push({
      mask: mask?.length ? new Uint8Array(mask) : null,
      cutoutMask: cutoutMaskRef.current ? new Uint8Array(cutoutMaskRef.current) : null,
      rectangles: [...rectangleCutsRef.current],
      outlines: sourceGeometry.current.roofOutlines.map(outline => outline.map(point => ({ ...point }))),
      holes: interiorHolesRef.current.map(hole => hole.map(point => ({ ...point }))),
    });
  }, []);

  const emitOutlinesAndHoles = useCallback((mask: Uint8Array, w: number, h: number) => {
    const outlines = extractMultipleOutlines(mask, w, h, allowedMaskRef.current);
    const holes = onHolesExtracted || rectangleCutsRef.current.length
      ? extractInteriorHoles(mask, w, h, 200, allowedMaskRef.current) : [];
    // Outline cleanup expands pixel masks. Reapply explicit rectangles to keep those cuts exact.
    const result = subtractRectangles(outlines, holes, rectangleCutsRef.current);
    onOutlinesExtracted(result.outlines);
    interiorHolesRef.current = result.holes;
    onHolesExtracted?.(result.holes);
  }, [onOutlinesExtracted, onHolesExtracted]);

  const ZOOM_STEP = 0.15;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;
  const HOVER_THROTTLE = 250;
  const HOVER_MOVE_THRESHOLD = 15;

  const calculateFitScale = useCallback(() => {
    if (!containerRef.current || !pdfCanvas) return 1;
    const containerWidth = containerRef.current.clientWidth - 16;
    const containerHeight = containerRef.current.clientHeight - 16;
    return Math.min(containerWidth / pdfCanvas.width, containerHeight / pdfCanvas.height);
  }, [pdfCanvas]);

  // Initialize canvas and defer heavy computation
  useEffect(() => {
    const canvas = canvasRef.current;
    const preview = previewCanvasRef.current;
    if (!canvas || !preview || !pdfCanvas) return;

    const fit = calculateFitScale();
    setFitScale(fit);
    setDisplayScale(fit);

    canvas.width = pdfCanvas.width;
    canvas.height = pdfCanvas.height;
    preview.width = pdfCanvas.width;
    preview.height = pdfCanvas.height;

    const sizeW = `${pdfCanvas.width * fit}px`;
    const sizeH = `${pdfCanvas.height * fit}px`;
    canvas.style.width = sizeW;
    canvas.style.height = sizeH;
    preview.style.width = sizeW;
    preview.style.height = sizeH;

    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(pdfCanvas, 0, 0);
    originalImageDataRef.current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    allowedMaskRef.current = buildRoiFillMask(JSON.parse(regionBoxesKey) as Box2D[], canvas);
    setSelectionMessage(null);
    const manual = sourceGeometry.current;
    filledMaskRef.current = manual.roofOutlines.length
      ? rasterizeOutlinesWithHoles(manual.roofOutlines, manual.interiorHoles, canvas.width, canvas.height) : null;
    cutoutMaskRef.current = manual.interiorHoles.length
      ? rasterizeOutlinesWithHoles(manual.interiorHoles, [], canvas.width, canvas.height) : null;
    interiorHolesRef.current = manual.interiorHoles.map((hole) => hole.map((point) => ({ ...point })));
    maskHistoryRef.current = [];
    rectangleCutsRef.current = [];
    rectangleDragRef.current = null;
    setFillCount(manual.roofOutlines.length ? 1 : 0);

    regionLabelsRef.current = null;
    regionSeedsRef.current = null;
    regionSensitivityRef.current = null;
    setIsInitializing(true);
    const edgeFrame = requestAnimationFrame(() => {
      const imgData = originalImageDataRef.current!;
      const edgeMap = buildEdgeMap(imgData.data, canvas.width, canvas.height);
      cachedEdgeMapRef.current = edgeMap;
      setIsInitializing(false);
    });
    return () => {
      cancelAnimationFrame(edgeFrame);
      if (previewRafRef.current !== null) cancelAnimationFrame(previewRafRef.current);
      if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
      if (rectangleFrameRef.current !== null) cancelAnimationFrame(rectangleFrameRef.current);
      hoverTimerRef.current = null;
      isComputingRef.current = false;
    };
  }, [pdfCanvas, calculateFitScale, regionBoxesKey]);

  // Update canvas CSS size on zoom
  useEffect(() => {
    const canvas = canvasRef.current;
    const preview = previewCanvasRef.current;
    if (!canvas || !preview || !pdfCanvas) return;
    const sizeW = `${pdfCanvas.width * displayScale}px`;
    const sizeH = `${pdfCanvas.height * displayScale}px`;
    canvas.style.width = sizeW;
    canvas.style.height = sizeH;
    preview.style.width = sizeW;
    preview.style.height = sizeH;
  }, [displayScale, pdfCanvas]);

  // Handle window resize
  useEffect(() => {
    const handleResize = () => {
      const fit = calculateFitScale();
      setFitScale(fit);
      setDisplayScale(fit);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [calculateFitScale]);

  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current) return;
    const ctx = canvas.getContext("2d")!;
    const { width, height } = canvas;

    ctx.putImageData(originalImageDataRef.current, 0, 0);

    const previewMask = adjustDragRef.current?.previewMask ?? filledMaskRef.current;
    if (previewMask) {
      if (!overlayCanvasRef.current || overlayCanvasRef.current.width !== width || overlayCanvasRef.current.height !== height) {
        overlayCanvasRef.current = document.createElement("canvas");
        overlayCanvasRef.current.width = width;
        overlayCanvasRef.current.height = height;
      }
      const offCtx = overlayCanvasRef.current.getContext("2d")!;
      const overlayData = offCtx.createImageData(width, height);
      const mask = previewMask;
      const od = overlayData.data;
      for (let i = 0; i < width * height; i++) {
        if (mask[i]) {
          const idx = i * 4;
          od[idx] = FILL_COLOR[0];
          od[idx + 1] = FILL_COLOR[1];
          od[idx + 2] = FILL_COLOR[2];
          od[idx + 3] = FILL_COLOR[3];
        }
      }
      offCtx.putImageData(overlayData, 0, 0);
      ctx.globalAlpha = 0.35;
      ctx.drawImage(overlayCanvasRef.current, 0, 0);
      ctx.globalAlpha = 1.0;
    }

    // Draw outlines with edge highlighting for adjust tool
    const displayedOutlines = adjustDragRef.current?.previewEdit?.outlines ?? roofOutlines;
    for (let oi = 0; oi < displayedOutlines.length; oi++) {
      const outline = displayedOutlines[oi];
      if (outline.length <= 2) continue;

      // Draw each edge individually to support highlighting
      for (let ei = 0; ei < outline.length; ei++) {
        const p1 = outline[ei];
        const p2 = outline[(ei + 1) % outline.length];
        const isHovered = (activeTool === "adjust" || activeTool === "straighten") &&
          hoveredEdge?.outlineIndex === oi &&
          hoveredEdge?.edgeIndex === ei;

        ctx.strokeStyle = isHovered ? "hsl(210, 85%, 55%)" : "hsl(0, 85%, 50%)";
        const edgeScale = activeTool === "adjust" || activeTool === "straighten" ? displayScale : 1;
        ctx.lineWidth = (isHovered ? 5 : 3) / edgeScale;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }

      for (let vi = 0; vi < outline.length; vi++) {
        const pt = outline[vi];
        const isVertexHovered = activeTool === "adjust" &&
          hoveredVertex?.outlineIndex === oi &&
          hoveredVertex?.vertexIndex === vi;
        ctx.fillStyle = isVertexHovered ? "hsl(210, 85%, 55%)" : "hsl(0, 85%, 50%)";
        ctx.beginPath();
        const handleScale = activeTool === "adjust" || activeTool === "straighten" ? displayScale : 1;
        ctx.arc(pt.x, pt.y, (isVertexHovered ? 7 : 4) / handleScale, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    const mergeTarget = adjustDragRef.current?.mergeTarget;
    if (mergeTarget) {
      ctx.strokeStyle = "#00875a";
      ctx.lineWidth = 2 / displayScale;
      ctx.beginPath();
      ctx.arc(mergeTarget.x, mergeTarget.y, 11 / displayScale, 0, Math.PI * 2);
      ctx.stroke();
    }
  }, [roofOutlines, activeTool, hoveredEdge, hoveredVertex, displayScale]);

  useEffect(() => { redrawCanvas(); }, [roofOutlines, fillCount, redrawCanvas, hoveredEdge, adjustmentVersion]);

  // --- Preview logic ---
  const clearPreview = useCallback(() => {
    const preview = previewCanvasRef.current;
    if (!preview) return;
    preview.getContext("2d")!.clearRect(0, 0, preview.width, preview.height);
    previewMaskRef.current = null;
    lastPreviewPosRef.current = null;
  }, []);

  const renderPreviewMask = useCallback((mask: Uint8Array, color: readonly [number, number, number, number]) => {
    const preview = previewCanvasRef.current;
    if (!preview) return;
    const ctx = preview.getContext("2d")!;
    const { width, height } = preview;
    ctx.clearRect(0, 0, width, height);
    const imgData = ctx.createImageData(width, height);
    const d = imgData.data;
    for (let i = 0; i < width * height; i++) {
      if (mask[i]) {
        const idx = i * 4;
        d[idx] = color[0]; d[idx + 1] = color[1]; d[idx + 2] = color[2]; d[idx + 3] = color[3];
      }
    }
    ctx.putImageData(imgData, 0, 0);
    previewMaskRef.current = mask;
  }, []);

  const computePreview = useCallback((hx: number, hy: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current || isComputingRef.current || isDraggingRef.current) return;

    const w = canvas.width;
    const h = canvas.height;
    if (hx < 0 || hx >= w || hy < 0 || hy >= h) { clearPreview(); return; }

    const currentMask = filledMaskRef.current;
    const origData = originalImageDataRef.current;

    isComputingRef.current = true;
    if (previewRafRef.current) cancelAnimationFrame(previewRafRef.current);

    previewRafRef.current = requestAnimationFrame(() => {
      if (activeTool === "cutout") {
        if (!currentMask || !currentMask[hy * w + hx]) {
          clearPreview(); isComputingRef.current = false; return;
        }
        const tempMask = new Uint8Array(currentMask);
        eraseFill(tempMask, w, h, hx, hy, origData, cutoutSensitivity);
        const previewMask = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
          if (currentMask[i] && !tempMask[i]) previewMask[i] = 1;
        }
        renderPreviewMask(previewMask, PREVIEW_CUTOUT_COLOR);
        isComputingRef.current = false;
        return;
      }

      // Fill tool: hovering on filled area — show removal preview
      if (currentMask && currentMask[hy * w + hx]) {
        const previewMask = new Uint8Array(w * h);
        const visited = new Uint8Array(w * h);
        const stack: number[] = [hx, hy];
        while (stack.length > 0) {
          const sy = stack.pop()!;
          const sx = stack.pop()!;
          if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
          const si = sy * w + sx;
          if (visited[si] || !currentMask[si]) continue;
          visited[si] = 1;
          previewMask[si] = 1;
          stack.push(sx + 1, sy, sx - 1, sy, sx, sy + 1, sx, sy - 1);
        }
        renderPreviewMask(previewMask, PREVIEW_REMOVE_COLOR);
        isComputingRef.current = false;
        return;
      }

      // Fill preview
      const edgeMap = cachedEdgeMapRef.current;
      if (!edgeMap) { isComputingRef.current = false; return; }

      const result = floodFillPreview(origData.data, w, h, hx, hy, edgeMap, currentMask || undefined, selectionSensitivity, allowedMaskRef.current);
      if (result.filledPixelCount < 50) { clearPreview(); isComputingRef.current = false; return; }

      const previewMask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (result.filledMask[i] && (!currentMask || !currentMask[i]) && !cutoutMaskRef.current?.[i]) previewMask[i] = 1;
      }
      renderPreviewMask(previewMask, PREVIEW_FILL_COLOR);
      isComputingRef.current = false;
    });
  }, [activeTool, cutoutSensitivity, selectionSensitivity, clearPreview, renderPreviewMask]);

  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) / displayScale);
    const y = Math.round((e.clientY - rect.top) / displayScale);
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return null;
    return { x, y };
  }, [displayScale]);

  const cancelRectangleDrag = useCallback(() => {
    const drag = rectangleDragRef.current;
    rectangleDragRef.current = null;
    if (rectangleFrameRef.current !== null) cancelAnimationFrame(rectangleFrameRef.current);
    rectangleFrameRef.current = null;
    const canvas = previewCanvasRef.current;
    if (drag && canvas?.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    clearPreview();
  }, [clearPreview]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape" && rectangleDragRef.current) {
        cancelRectangleDrag();
        setSelectionMessage("Rectangle cut cancelled.");
      }
    };
    window.addEventListener("keydown", cancel);
    window.addEventListener("blur", cancelRectangleDrag);
    return () => {
      window.removeEventListener("keydown", cancel);
      window.removeEventListener("blur", cancelRectangleDrag);
      cancelRectangleDrag();
    };
  }, [activeTool, displayScale, cancelRectangleDrag]);

  const rectanglePosition = useCallback((event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round((event.clientX - bounds.left) / displayScale),
      y: Math.round((event.clientY - bounds.top) / displayScale),
    };
  }, [displayScale]);

  const previewRectangle = useCallback(() => {
    rectangleFrameRef.current = null;
    const drag = rectangleDragRef.current;
    const canvas = previewCanvasRef.current;
    if (!drag || !canvas) return;
    const { left, top, right, bottom } = cutoutRectangle(drag.start, drag.end, canvas.width, canvas.height);
    clearPreview();
    if (right <= left || bottom <= top) return;
    const ctx = canvas.getContext("2d")!;
    // Only allocate the rectangle's pixels while dragging on large plan images.
    const image = ctx.createImageData(right - left, bottom - top);
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      if (drag.mask[y * canvas.width + x]) {
        image.data.set(PREVIEW_CUTOUT_COLOR, ((y - top) * image.width + x - left) * 4);
      }
    }
    ctx.putImageData(image, left, top);
    ctx.strokeStyle = "rgba(230, 110, 0, 0.9)";
    ctx.lineWidth = 2 / displayScale;
    ctx.setLineDash([6 / displayScale, 4 / displayScale]);
    ctx.strokeRect(left, top, right - left, bottom - top);
    ctx.setLineDash([]);
  }, [clearPreview, displayScale]);

  const handleRectangleDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (activeTool !== "rectangle-cutout" || isInitializing || event.button !== 0 || rectangleDragRef.current) return;
    const canvas = event.currentTarget;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    const start = rectanglePosition(event);
    rectangleDragRef.current = {
      start, end: start, pointerId: event.pointerId,
      mask: rasterizeOutlinesWithHoles(roofOutlines, interiorHolesRef.current, canvas.width, canvas.height),
    };
    setSelectionMessage(null);
    clearPreview();
  }, [activeTool, isInitializing, rectanglePosition, roofOutlines, clearPreview]);

  const handleRectangleMove = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = rectangleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.end = rectanglePosition(event);
    if (rectangleFrameRef.current === null) rectangleFrameRef.current = requestAnimationFrame(previewRectangle);
  }, [rectanglePosition, previewRectangle]);

  const handleRectangleUp = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = rectangleDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const canvas = event.currentTarget;
    const end = rectanglePosition(event);
    const rect = cutoutRectangle(drag.start, end, canvas.width, canvas.height);
    cancelRectangleDrag();
    // A click or accidental movement must not remove a thin strip of roof.
    if ((rect.right - rect.left) * displayScale < 3 || (rect.bottom - rect.top) * displayScale < 3) return;
    const result = subtractRectangles(roofOutlines, interiorHolesRef.current, [rect]);
    if (!result.changed) {
      setSelectionMessage("No selected area inside that rectangle.");
      return;
    }
    saveHistory();
    rectangleCutsRef.current.push(rect);
    const mask = rasterizeOutlinesWithHoles(result.outlines, result.holes, canvas.width, canvas.height);
    // Remove the rectangle from the source mask and prevent later fills from restoring it.
    if (!cutoutMaskRef.current) cutoutMaskRef.current = new Uint8Array(mask.length);
    for (let y = rect.top; y < rect.bottom; y++) {
      mask.fill(0, y * canvas.width + rect.left, y * canvas.width + rect.right);
      cutoutMaskRef.current.fill(1, y * canvas.width + rect.left, y * canvas.width + rect.right);
    }
    filledMaskRef.current = mask;
    interiorHolesRef.current = result.holes;
    onOutlinesExtracted(result.outlines);
    onHolesExtracted?.(result.holes);
    setFillCount(count => count + 1);
    setSelectionMessage("Selected area inside the rectangle removed. Use Undo to restore it.");
  }, [rectanglePosition, cancelRectangleDrag, displayScale, roofOutlines, saveHistory, onOutlinesExtracted, onHolesExtracted]);

  const fillAtPoint = useCallback((x: number, y: number): boolean => {
    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current) return false;
    const w = canvas.width, h = canvas.height;
    const origData = originalImageDataRef.current;
    const currentMask = filledMaskRef.current;

    if (currentMask && currentMask[y * w + x]) return false;
    if (cutoutMaskRef.current && cutoutMaskRef.current[y * w + x]) return false;

    const imageData = new ImageData(new Uint8ClampedArray(origData.data), w, h);
    const result = floodFill(imageData, x, y, FILL_COLOR, currentMask || undefined, selectionSensitivity, true, allowedMaskRef.current);
    if (result.filledPixelCount < 50) {
      setSelectionMessage("No area found at this spot. Click a clear part of the roof away from lines and symbols.");
      return false;
    }

    const cutout = cutoutMaskRef.current;
    if (cutout) {
      for (let i = 0; i < w * h; i++) {
        if (cutout[i]) result.filledMask[i] = 0;
      }
    }

    filledMaskRef.current = result.filledMask;
    setSelectionMessage(null);
    return true;
  }, [selectionSensitivity]);

  // --- Rectangle drag for multi-select ---
  const getRegionsInRect = useCallback((x1: number, y1: number, x2: number, y2: number, w: number): Set<number> => {
    if (regionSensitivityRef.current !== selectionSensitivity) {
      const image = originalImageDataRef.current;
      const edgeMap = cachedEdgeMapRef.current;
      if (!image || !edgeMap) return new Set();
      const { regionLabels, regionSeeds } = buildRegionMap(
        image.data, image.width, image.height, edgeMap, selectionSensitivity, allowedMaskRef.current
      );
      regionLabelsRef.current = regionLabels;
      regionSeedsRef.current = regionSeeds;
      regionSensitivityRef.current = selectionSensitivity;
    }
    const labels = regionLabelsRef.current;
    const seeds = regionSeedsRef.current;
    if (!labels || !seeds) return new Set();

    const currentMask = filledMaskRef.current;
    const cutout = cutoutMaskRef.current;
    const hitRegions = new Set<number>();

    const step = Math.max(2, Math.round(Math.min(x2 - x1, y2 - y1) / 40));
    for (let y = y1; y <= y2; y += step) {
      for (let x = x1; x <= x2; x += step) {
        const pi = y * w + x;
        const regionId = labels[pi];
        if (regionId <= 0 || hitRegions.has(regionId)) continue;
        if (!seeds.has(regionId)) continue;
        if (currentMask && currentMask[pi]) continue;
        if (cutout && cutout[pi]) continue;
        hitRegions.add(regionId);
      }
    }
    return hitRegions;
  }, [selectionSensitivity]);

  const buildRegionPreviewMask = useCallback((regionIds: Set<number>, w: number, h: number): Uint8Array => {
    const labels = regionLabelsRef.current;
    const mask = new Uint8Array(w * h);
    if (!labels || regionIds.size === 0) return mask;
    const currentMask = filledMaskRef.current;
    const cutout = cutoutMaskRef.current;

    for (let i = 0; i < w * h; i++) {
      if (regionIds.has(labels[i]) && (!currentMask || !currentMask[i]) && (!cutout || !cutout[i])) {
        mask[i] = 1;
      }
    }
    return mask;
  }, []);

  const renderRectPreview = useCallback(() => {
    const preview = previewCanvasRef.current;
    const canvas = canvasRef.current;
    const start = dragStartRef.current;
    const current = dragCurrentRef.current;
    if (!preview || !canvas || !start || !current) return;

    const w = canvas.width, h = canvas.height;
    const ctx = preview.getContext("2d")!;
    ctx.clearRect(0, 0, w, h);

    const x1 = Math.max(0, Math.min(start.x, current.x));
    const y1 = Math.max(0, Math.min(start.y, current.y));
    const x2 = Math.min(w - 1, Math.max(start.x, current.x));
    const y2 = Math.min(h - 1, Math.max(start.y, current.y));

    if (x2 - x1 > 5 || y2 - y1 > 5) {
      const regionIds = getRegionsInRect(x1, y1, x2, y2, w);
      if (regionIds.size > 0) {
        const previewMask = buildRegionPreviewMask(regionIds, w, h);
        const imgData = ctx.createImageData(w, h);
        const d = imgData.data;
        for (let i = 0; i < w * h; i++) {
          if (previewMask[i]) {
            const idx = i * 4;
            d[idx] = PREVIEW_FILL_COLOR[0]; d[idx + 1] = PREVIEW_FILL_COLOR[1];
            d[idx + 2] = PREVIEW_FILL_COLOR[2]; d[idx + 3] = PREVIEW_FILL_COLOR[3];
          }
        }
        ctx.putImageData(imgData, 0, 0);
      }
    }

    ctx.strokeStyle = "rgba(50, 130, 220, 0.8)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    ctx.setLineDash([]);
  }, [getRegionsInRect, buildRegionPreviewMask]);

  const commitAdjustment = useCallback((edit: OutlineEditResult, mask?: Uint8Array | null) => {
    const canvas = canvasRef.current;
    if (!canvas || edit.error) { setSelectionMessage(edit.error); return; }
    const previous = sourceGeometry.current;
    const holesChanged = JSON.stringify(edit.holes) !== JSON.stringify(interiorHolesRef.current);
    if (!holesChanged && JSON.stringify(edit.outlines) === JSON.stringify(previous.roofOutlines)) return;
    saveHistory();
    filledMaskRef.current = mask ?? rasterizeOutlinesWithHoles(edit.outlines, edit.holes, canvas.width, canvas.height);
    if (holesChanged) {
      const previousHoleMask = rasterizeOutlinesWithHoles(interiorHolesRef.current, [], canvas.width, canvas.height);
      const nextHoleMask = rasterizeOutlinesWithHoles(edit.holes, [], canvas.width, canvas.height);
      const exclusions = new Uint8Array(cutoutMaskRef.current ?? previousHoleMask);
      for (let index = 0; index < exclusions.length; index++) {
        if (previousHoleMask[index]) exclusions[index] = 0;
        if (nextHoleMask[index]) exclusions[index] = 1;
      }
      for (const rectangle of rectangleCutsRef.current) {
        for (let row = rectangle.top; row < rectangle.bottom; row++) {
          exclusions.fill(1, row * canvas.width + rectangle.left, row * canvas.width + rectangle.right);
        }
      }
      cutoutMaskRef.current = exclusions;
      interiorHolesRef.current = edit.holes;
    }
    onOutlinesExtracted(edit.outlines, edit.editedOutlineIndex);
    if (holesChanged) onHolesExtracted?.(edit.holes);
    setFillCount(count => count + 1);
    setSelectionMessage(edit.repaired ? "Existing boundary defects repaired." : null);
  }, [saveHistory, onOutlinesExtracted, onHolesExtracted]);

  const cancelAdjustment = useCallback(() => {
    const drag = adjustDragRef.current;
    if (!drag) return;
    adjustDragRef.current = null;
    const canvas = previewCanvasRef.current;
    if (canvas?.hasPointerCapture(drag.pointerId)) canvas.releasePointerCapture(drag.pointerId);
    setAdjustmentVersion(version => version + 1);
    setSelectionMessage(null);
  }, []);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancelAdjustment(); };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", cancelAdjustment);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", cancelAdjustment);
      cancelAdjustment();
    };
  }, [activeTool, displayScale, pdfCanvas, cancelAdjustment]);

  const handleAdjustmentDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || isInitializing || adjustDragRef.current || (activeTool !== "adjust" && activeTool !== "straighten")) return;
    const position = getCanvasPos(event);
    if (!position) return;
    setSelectionMessage(null);
    const vertex = activeTool === "adjust" ? findClosestVertex(position.x, position.y, roofOutlines, 10 / displayScale) : null;
    const edge = vertex ? null : findClosestEdge(position.x, position.y, roofOutlines, 12 / displayScale);
    const outlineIndex = vertex?.outlineIndex ?? edge?.outlineIndex;
    if (outlineIndex === undefined) return;
    adjustDragRef.current = {
      type: vertex ? "vertex" : "edge", outlineIndex,
      vertexIndex: vertex?.vertexIndex, edgeIndex: edge?.edgeIndex,
      startX: position.x, startY: position.y, pointerId: event.pointerId,
      originalOutlines: roofOutlines.map(outline => outline.map(point => ({ ...point }))),
      originalHoles: interiorHolesRef.current.map(hole => hole.map(point => ({ ...point }))),
      previewEdit: null, previewMask: null, mergeTarget: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const previewAdjustment = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = adjustDragRef.current;
    const position = getCanvasPos(event);
    const canvas = canvasRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !position || !canvas) return;
    const original = drag.originalOutlines[drag.outlineIndex];
    const prepare = (candidate: Point[], edgeMove = false): OutlineEditResult => {
      if (candidate.some(point => point.x < 0 || point.y < 0 || point.x > canvas.width || point.y > canvas.height)) {
        return { outlines: drag.originalOutlines, holes: drag.originalHoles, repaired: false,
          error: "Edit blocked: the boundary would extend outside the drawing page." };
      }
      return edgeMove
        ? prepareEdgeEdit(drag.originalOutlines, drag.outlineIndex, drag.edgeIndex!,
          position.x - drag.startX, position.y - drag.startY, drag.originalHoles)
        : prepareOutlineEdit(drag.originalOutlines, drag.outlineIndex, candidate, drag.originalHoles);
    };
    let candidate: Point[] | null;
    drag.mergeTarget = null;
    if (activeTool === "straighten") {
      candidate = straightenPolygonSide(original, drag.edgeIndex!);
    } else if (drag.type === "vertex") {
      const vertexIndex = drag.vertexIndex!;
      let destination = {
        x: Math.round(original[vertexIndex].x + position.x - drag.startX),
        y: Math.round(original[vertexIndex].y + position.y - drag.startY),
      };
      const target = event.shiftKey ? null : findVertexMergeTarget(original, vertexIndex, destination, 8 / displayScale);
      if (target !== null) {
        candidate = mergePolygonVertex(original, vertexIndex, target);
        if (candidate) drag.mergeTarget = original[target];
      } else {
        const moved = (point: Point) => original.map((existing, index) => index === vertexIndex ? point : existing);
        if (event.shiftKey) {
          const previous = original[(vertexIndex + original.length - 1) % original.length];
          const next = original[(vertexIndex + 1) % original.length];
          const options = [{ x: previous.x, y: next.y }, { x: next.x, y: previous.y }]
            .sort((first, second) => Math.hypot(first.x - destination.x, first.y - destination.y) - Math.hypot(second.x - destination.x, second.y - destination.y));
          const snapped = options.find(option => !prepare(moved(option)).error);
          if (snapped) destination = snapped;
          else {
            drag.previewEdit = null;
            drag.previewMask = null;
            setSelectionMessage(prepare(moved(options[0])).error);
            setAdjustmentVersion(version => version + 1);
            return;
          }
        }
        candidate = moved(destination);
      }
    } else {
      candidate = movePolygonEdge(original, drag.edgeIndex!, position.x - drag.startX, position.y - drag.startY);
    }
    const edit = candidate ? prepare(candidate, activeTool === "adjust" && drag.type === "edge") : null;
    if (!edit || edit.error) {
      drag.previewEdit = null;
      drag.previewMask = null;
      drag.mergeTarget = null;
      setSelectionMessage(edit?.error ?? "This side is not close enough to horizontal or vertical.");
    } else {
      drag.previewEdit = edit;
      drag.previewMask = rasterizeOutlinesWithHoles(edit.outlines, edit.holes, canvas.width, canvas.height);
      setSelectionMessage(drag.mergeTarget ? "Merge vertex" : edit.repaired ? "Existing boundary defects will be repaired." : null);
    }
    setAdjustmentVersion(version => version + 1);
  };

  const handleAdjustmentMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (isInitializing || (activeTool !== "adjust" && activeTool !== "straighten")) return;
    if (adjustDragRef.current) { previewAdjustment(event); return; }
    const position = getCanvasPos(event);
    if (!position) return;
    const vertex = activeTool === "adjust" ? findClosestVertex(position.x, position.y, roofOutlines, 10 / displayScale) : null;
    setHoveredVertex(vertex);
    setHoveredEdge(vertex ? null : findClosestEdge(position.x, position.y, roofOutlines, 12 / displayScale));
  };

  const handleAdjustmentUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = adjustDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const position = getCanvasPos(event);
    if (!position) { cancelAdjustment(); return; }
    const moved = position && Math.hypot(position.x - drag.startX, position.y - drag.startY) * displayScale >= 2;
    if (moved || activeTool === "straighten") previewAdjustment(event);
    else { cancelAdjustment(); return; }
    adjustDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (drag.previewEdit) commitAdjustment(drag.previewEdit, drag.previewMask);
    setHoveredVertex(null);
    setHoveredEdge(null);
    setAdjustmentVersion(version => version + 1);
  };

  // --- Mouse handlers ---
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || isInitializing || activeTool === "rectangle-cutout" || activeTool === "adjust" || activeTool === "straighten") return;
    const pos = getCanvasPos(e);
    if (!pos) return;

    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current) return;
    const w = canvas.width;
    const currentMask = filledMaskRef.current;

    if (activeTool === "fill" && allowedMaskRef.current && !allowedMaskRef.current[pos.y * w + pos.x]) {
      setSelectionMessage("Click inside a green roof region to select an area.");
      clearPreview();
      return;
    }
    setSelectionMessage(null);

    if (activeTool === "fill" && (!currentMask || !currentMask[pos.y * w + pos.x])) {
      dragStartRef.current = pos;
      dragCurrentRef.current = pos;
      isDraggingRef.current = true;
      justDraggedRef.current = false;

      dragMaskBeforeRef.current = currentMask ? new Uint8Array(currentMask) : new Uint8Array(0);
      clearPreview();
      return;
    }
  }, [getCanvasPos, activeTool, clearPreview, isInitializing]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isInitializing || activeTool === "rectangle-cutout" || activeTool === "adjust" || activeTool === "straighten") return;
    const pos = getCanvasPos(e);
    if (!pos) return;

    if (isDraggingRef.current && activeTool === "fill") {
      dragCurrentRef.current = pos;
      renderRectPreview();
      return;
    }

    const last = lastPreviewPosRef.current;
    if (last && Math.abs(pos.x - last.x) < HOVER_MOVE_THRESHOLD && Math.abs(pos.y - last.y) < HOVER_MOVE_THRESHOLD) return;
    lastPreviewPosRef.current = pos;

    if (hoverTimerRef.current) return;
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null;
      const p = lastPreviewPosRef.current;
      if (p) computePreview(p.x, p.y);
    }, HOVER_THROTTLE);
  }, [getCanvasPos, computePreview, activeTool, renderRectPreview, isInitializing]);

  const handleMouseUp = useCallback(() => {
    if (!isDraggingRef.current) return;
    isDraggingRef.current = false;

    const start = dragStartRef.current;
    const end = dragCurrentRef.current;
    const canvas = canvasRef.current;

    if (!start || !end || !canvas || !originalImageDataRef.current) {
      dragStartRef.current = null;
      dragCurrentRef.current = null;
      clearPreview();
      return;
    }

    const w = canvas.width, h = canvas.height;
    const x1 = Math.max(0, Math.min(start.x, end.x));
    const y1 = Math.max(0, Math.min(start.y, end.y));
    const x2 = Math.min(w - 1, Math.max(start.x, end.x));
    const y2 = Math.min(h - 1, Math.max(start.y, end.y));

    // Small rect = single click
    if (x2 - x1 < 5 && y2 - y1 < 5) {
      justDraggedRef.current = true;
      dragStartRef.current = null;
      dragCurrentRef.current = null;
      clearPreview();

      if (fillAtPoint(start.x, start.y)) {
        const beforeMask = dragMaskBeforeRef.current;
        if (beforeMask) saveHistory(beforeMask);
        setFillCount(c => c + 1);
        redrawCanvas();
        emitOutlinesAndHoles(filledMaskRef.current!, w, h);
      }
      dragMaskBeforeRef.current = null;
      requestAnimationFrame(() => { justDraggedRef.current = false; });
      return;
    }

    justDraggedRef.current = true;

    const regionIds = getRegionsInRect(x1, y1, x2, y2, w);
    let filled = false;

    if (regionIds.size > 0) {
      const regionPixels = buildRegionPreviewMask(regionIds, w, h);
      const currentMask = filledMaskRef.current || new Uint8Array(w * h);
      let newCount = 0;

      for (let i = 0; i < w * h; i++) {
        if (regionPixels[i] && !currentMask[i]) { currentMask[i] = 1; newCount++; }
      }

      if (newCount > 0) { filledMaskRef.current = currentMask; filled = true; }
    }

    if (filled) {
      const beforeMask = dragMaskBeforeRef.current;
      if (beforeMask) saveHistory(beforeMask);
      setFillCount(c => c + 1);
      redrawCanvas();
      if (filledMaskRef.current) {
        emitOutlinesAndHoles(filledMaskRef.current, w, h);
      }
    }

    dragStartRef.current = null;
    dragCurrentRef.current = null;
    dragMaskBeforeRef.current = null;
    clearPreview();
    redrawCanvas();
    requestAnimationFrame(() => { justDraggedRef.current = false; });
  }, [emitOutlinesAndHoles, clearPreview, redrawCanvas, getRegionsInRect, buildRegionPreviewMask, fillAtPoint, saveHistory]);

  const handleMouseLeave = useCallback(() => {
    if (rectangleDragRef.current) return; // Pointer capture keeps the rectangle active until release.
    if (adjustDragRef.current) return;
    if (isDraggingRef.current) handleMouseUp();
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    setHoveredEdge(null);
    setHoveredVertex(null);
    clearPreview();
  }, [clearPreview, handleMouseUp]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (activeTool !== "adjust") return;
    e.preventDefault();
    const pos = getCanvasPos(e);
    if (!pos) return;

    const edge = findClosestEdge(pos.x, pos.y, roofOutlines, 15);
    if (!edge) return;

    const outline = roofOutlines[edge.outlineIndex];
    if (outline.length <= 3) return; // Can't delete from a triangle

    // Remove the second vertex of the edge; the polygon reconnects automatically
    const vertexToRemove = (edge.edgeIndex + 1) % outline.length;
    const newOutline = outline.filter((_, i) => i !== vertexToRemove);

    commitAdjustment(prepareOutlineEdit(roofOutlines, edge.outlineIndex, newOutline, interiorHolesRef.current));
    setHoveredEdge(null);
    setHoveredVertex(null);
  }, [activeTool, getCanvasPos, roofOutlines, commitAdjustment]);

  useEffect(() => {
    // Discard work queued with the previous tool or sensitivity before the next hover.
    if (hoverTimerRef.current !== null) clearTimeout(hoverTimerRef.current);
    if (previewRafRef.current !== null) cancelAnimationFrame(previewRafRef.current);
    hoverTimerRef.current = null;
    previewRafRef.current = null;
    isComputingRef.current = false;
    clearPreview();
    setHoveredEdge(null);
    setHoveredVertex(null);
  }, [activeTool, cutoutSensitivity, selectionSensitivity, clearPreview]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (justDraggedRef.current || isInitializing || activeTool === "adjust" || activeTool === "straighten" || activeTool === "rectangle-cutout") return;
    const pos = getCanvasPos(e);
    if (!pos) return;
    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current) return;

    const origData = originalImageDataRef.current;
    const w = canvas.width, h = canvas.height;
    const currentMask = filledMaskRef.current;

    if (activeTool === "cutout") {
      if (!currentMask || !currentMask[pos.y * w + pos.x]) return;
      saveHistory();
      const beforeMask = new Uint8Array(currentMask);
      eraseFill(currentMask, w, h, pos.x, pos.y, origData, cutoutSensitivity);

      if (!cutoutMaskRef.current) cutoutMaskRef.current = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (beforeMask[i] && !currentMask[i]) cutoutMaskRef.current[i] = 1;
      }

      setFillCount(c => c + 1);
      emitOutlinesAndHoles(currentMask, w, h);
      clearPreview();
      return;
    }

    // Fill tool: clicking filled area removes it
    if (currentMask && currentMask[pos.y * w + pos.x]) {
      saveHistory();
      const newMask = new Uint8Array(currentMask);
      const visited = new Uint8Array(w * h);
      const stack: number[] = [pos.x, pos.y];
      while (stack.length > 0) {
        const sy = stack.pop()!;
        const sx = stack.pop()!;
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
        const si = sy * w + sx;
        if (visited[si] || !newMask[si]) continue;
        visited[si] = 1;
        newMask[si] = 0;
        stack.push(sx + 1, sy, sx - 1, sy, sx, sy + 1, sx, sy - 1);
      }
      filledMaskRef.current = newMask;
      setFillCount(c => c + 1);
      emitOutlinesAndHoles(newMask, w, h);
      clearPreview();
      return;
    }
  }, [getCanvasPos, emitOutlinesAndHoles, activeTool, cutoutSensitivity, clearPreview, isInitializing, saveHistory]);

  const handleUndo = useCallback(() => {
    if (maskHistoryRef.current.length === 0) return;
    const previous = maskHistoryRef.current.pop()!;
    filledMaskRef.current = previous.mask;
    cutoutMaskRef.current = previous.cutoutMask;
    rectangleCutsRef.current = previous.rectangles;
    interiorHolesRef.current = previous.holes;
    setFillCount(c => Math.max(0, c - 1));
    onOutlinesExtracted(previous.outlines);
    onHolesExtracted?.(previous.holes);
    setSelectionMessage(null);
    clearPreview();
  }, [onOutlinesExtracted, onHolesExtracted, clearPreview]);

  const handleReset = useCallback(() => {
    filledMaskRef.current = null;
    cutoutMaskRef.current = null;
    rectangleCutsRef.current = [];
    interiorHolesRef.current = [];
    maskHistoryRef.current = [];
    setFillCount(0);
    onOutlinesExtracted([]);
    if (onHolesExtracted) onHolesExtracted([]);
    setSelectionMessage(null);
    clearPreview();
  }, [onOutlinesExtracted, onHolesExtracted, clearPreview]);

  const handleZoomIn = () => setDisplayScale(s => Math.min(s + ZOOM_STEP, MAX_ZOOM));
  const handleZoomOut = () => setDisplayScale(s => Math.max(s - ZOOM_STEP, MIN_ZOOM));
  const handleFitToScreen = () => setDisplayScale(fitScale);
  const zoomPercent = Math.round((displayScale / fitScale) * 100);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setDisplayScale(s => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s + delta)));
    }
  }, []);

  const hasAnyFill = fillCount > 0;
  const canUndo = maskHistoryRef.current.length > 0;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
        <div className="flex flex-wrap items-center border border-border rounded-md overflow-hidden">
          <Button
            variant={activeTool === "fill" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTool("fill")}
            title="Select roof areas"
            className="rounded-none"
            disabled={isInitializing}
          >
            <PaintBucket className="w-4 h-4 mr-1" />
            Select
          </Button>
          <Button
            variant={activeTool === "cutout" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTool("cutout")}
            title="Cut out areas from fill"
            className="rounded-none"
            disabled={isInitializing}
          >
            <Scissors className="w-4 h-4 mr-1" />
            Cut Out
          </Button>
          <Button
            variant={activeTool === "rectangle-cutout" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTool("rectangle-cutout")}
            title="Drag a rectangle to remove selected areas inside it"
            aria-pressed={activeTool === "rectangle-cutout"}
            className="rounded-none"
            disabled={isInitializing || !roofOutlines.length}
          >
            <RectangleHorizontal className="w-4 h-4 mr-1" />
            Cut Out rectangle
          </Button>
          <Button
            variant={activeTool === "adjust" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTool("adjust")}
            title="Drag edges or vertices; drop onto a neighbouring vertex to merge. Shift aligns a corner."
            aria-pressed={activeTool === "adjust"}
            className="rounded-none"
            disabled={isInitializing || !hasAnyFill}
          >
            <Move className="w-4 h-4 mr-1" />
            Adjust
          </Button>
          <Button
            variant={activeTool === "straighten" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTool("straighten")}
            title="Click a side to align it horizontally or vertically, including intermediate points"
            aria-pressed={activeTool === "straighten"}
            className="rounded-none"
            disabled={isInitializing || !roofOutlines.length}
          >
            <Ruler className="w-4 h-4 mr-1" />
            Straighten
          </Button>
        </div>

        <div className="w-px h-6 bg-border mx-1" />

        <Button variant="outline" size="sm" onClick={handleZoomOut} title="Zoom out">
          <ZoomOut className="w-4 h-4" />
        </Button>
        <span className="text-xs font-medium text-muted-foreground min-w-[48px] text-center">
          {zoomPercent}%
        </span>
        <Button variant="outline" size="sm" onClick={handleZoomIn} title="Zoom in">
          <ZoomIn className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={handleFitToScreen} title="Fit to screen">
          <Maximize className="w-4 h-4" />
        </Button>

        {hasAnyFill && (
          <>
            <div className="w-px h-6 bg-border mx-1" />
            <Button variant="outline" size="sm" onClick={handleUndo} disabled={!canUndo} title="Undo last action">
              <Undo2 className="w-4 h-4 mr-1" />
              Undo
            </Button>
            <Button variant="destructive" size="sm" onClick={handleReset} title="Reset all">
              <RotateCcw className="w-4 h-4 mr-1" />
              Reset
            </Button>
            <div className="w-px h-6 bg-border mx-1" />
            <span className="text-xs text-muted-foreground">
              {roofOutlines.length} roof area{roofOutlines.length !== 1 ? "s" : ""} detected
            </span>
          </>
        )}

        {isInitializing && (
          <>
            <div className="w-px h-6 bg-border mx-1" />
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">Analyzing plan...</span>
          </>
        )}
      </div>

      {activeTool === "fill" && <div className="rounded-md border border-border bg-muted/30 px-3 py-2 mb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label htmlFor={selectionSensitivityId} className="text-sm font-medium">Selection sensitivity</label>
          <input id={selectionSensitivityId} type="range" min={1} max={100} step={1}
            value={selectionSensitivity} onChange={(event) => setSelectionSensitivity(Number(event.target.value))}
            disabled={isInitializing}
            className="w-48 max-w-full h-6 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-50" />
          <output htmlFor={selectionSensitivityId} className="text-sm tabular-nums w-7">{selectionSensitivity}</output>
          <Button variant="ghost" size="sm" onClick={() => setSelectionSensitivity(DEFAULT_SELECTION_SENSITIVITY)}
            disabled={isInitializing || selectionSensitivity === DEFAULT_SELECTION_SENSITIVITY}>
            Default (45)
          </Button>
        </div>
      </div>}

      {activeTool === "cutout" && <div className="rounded-md border border-border bg-muted/30 px-3 py-2 mb-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <label htmlFor={cutoutSensitivityId} className="text-sm font-medium">Cut Out sensitivity</label>
          <input id={cutoutSensitivityId} type="range" min={1} max={100} step={1}
            value={cutoutSensitivity} onChange={(event) => setCutoutSensitivity(Number(event.target.value))}
            aria-describedby={`${cutoutSensitivityId}-help`} disabled={isInitializing}
            className="w-48 max-w-full h-6 cursor-pointer accent-primary disabled:cursor-default disabled:opacity-50" />
          <output htmlFor={cutoutSensitivityId} className="text-sm tabular-nums w-7">{cutoutSensitivity}</output>
          <Button variant="ghost" size="sm" onClick={() => setCutoutSensitivity(DEFAULT_CUTOUT_SENSITIVITY)}
            disabled={isInitializing || cutoutSensitivity === DEFAULT_CUTOUT_SENSITIVITY}>
            Default (40)
          </Button>
        </div>
        <p id={`${cutoutSensitivityId}-help`} className="text-xs text-muted-foreground mt-1">
          Lower values give a tighter cut; higher values allow more spread. Hover over the area to preview before clicking.
        </p>
      </div>}

      {activeTool === "rectangle-cutout" && <p className="rounded-md border border-border bg-muted/30 px-3 py-2 mb-2 text-sm">
        Drag a rectangle around unwanted fragments, starting in empty space if needed. Orange shows what will be removed.
        Release to remove everything selected inside the rectangle, including any part of the main roof. Press Esc to cancel or Undo to restore.
      </p>}

      {acceptedRegions.length > 0 && <p className="text-xs text-muted-foreground px-1 mb-2">
        Selection stays inside the green roof regions. Use Cut Out or Adjust to refine the roof boundary.
      </p>}
      {(activeTool === "adjust" || activeTool === "straighten")
        ? <div role="status" className="h-12 shrink-0 overflow-y-auto text-sm text-muted-foreground px-1 mb-2">{selectionMessage}</div>
        : selectionMessage && <p role="status" className="text-sm text-muted-foreground px-1 mb-2">{selectionMessage}</p>}

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto border border-border rounded-lg bg-muted/30"
        onWheel={handleWheel}
      >
        <div className="min-w-fit min-h-fit p-2 relative">
          <canvas ref={canvasRef} className="block mx-auto" data-testid="paint-source-canvas" />
          <canvas
            ref={previewCanvasRef}
            data-testid="paint-interaction-canvas"
            onClick={handleCanvasClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onContextMenu={handleContextMenu}
            onPointerDown={event => { handleRectangleDown(event); handleAdjustmentDown(event); }}
            onPointerMove={event => { handleRectangleMove(event); handleAdjustmentMove(event); }}
            onPointerUp={event => { handleRectangleUp(event); handleAdjustmentUp(event); }}
            onPointerCancel={() => { cancelRectangleDrag(); cancelAdjustment(); }}
            onLostPointerCapture={() => { cancelRectangleDrag(); cancelAdjustment(); }}
            className={`absolute top-2 left-1/2 -translate-x-1/2 ${activeTool === "adjust" ? "cursor-move" : activeTool === "cutout" || activeTool === "straighten" ? "cursor-pointer" : "cursor-crosshair"}`}
            style={{ pointerEvents: "auto", touchAction: activeTool === "rectangle-cutout" || activeTool === "adjust" || activeTool === "straighten" ? "none" : "auto" }}
          />
          {acceptedRegions.length > 0 && <div className="absolute top-2 left-1/2 -translate-x-1/2 pointer-events-none"
            style={{ width: pdfCanvas.width * displayScale, height: pdfCanvas.height * displayScale }}>
            <AnnotationOverlay annotations={acceptedRegions} labels={regionLabels} />
          </div>}
        </div>
      </div>

      {activeTool !== "straighten" && <div className="flex items-center justify-center gap-2 mt-2 px-4">
        <MousePointer className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {activeTool === "rectangle-cutout"
            ? "Drag to preview a rectangular cut; release to apply. Esc cancels. Undo restores the selection."
            : activeTool === "adjust"
            ? "Drag edges or vertices to adjust — hold Shift to lock to 90° — right-click edge to delete — Ctrl + scroll to zoom"
            : activeTool === "fill"
            ? "Hover to preview — click or hold & drag to multi-select areas — click filled area to remove — Ctrl + scroll to zoom"
            : "Hover to preview — click inside a filled area to cut out a section — Ctrl + scroll to zoom"}
        </p>
      </div>}
    </div>
  );
};
