import { useRef, useEffect, useState, useCallback } from "react";
import { Point } from "@/types/roof";
import { floodFill, floodFillPreview, eraseFill, extractMultipleOutlines, extractInteriorHoles, buildEdgeMap, buildRegionMap } from "@/utils/floodFill";
import { findClosestEdge, findClosestVertex, movePolygonEdge, rasterizeOutlinesWithHoles } from "@/utils/polygonAdjust";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize, Undo2, RotateCcw, MousePointer, PaintBucket, Scissors, Move, Loader2 } from "lucide-react";

type PaintTool = "fill" | "cutout" | "adjust";

interface PaintBucketCanvasProps {
  pdfCanvas: HTMLCanvasElement;
  onOutlinesExtracted: (outlines: Point[][]) => void;
  onHolesExtracted?: (holes: Point[][]) => void;
  roofOutlines: Point[][];
}

const FILL_COLOR: [number, number, number, number] = [220, 50, 50, 160];
const PREVIEW_FILL_COLOR = [50, 130, 220, 100] as const;
const PREVIEW_REMOVE_COLOR = [220, 50, 50, 80] as const;
const PREVIEW_CUTOUT_COLOR = [255, 140, 0, 100] as const;

export const PaintBucketCanvas = ({
  pdfCanvas,
  onOutlinesExtracted,
  onHolesExtracted,
  roofOutlines,
}: PaintBucketCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [fillCount, setFillCount] = useState(0);
  const [activeTool, setActiveTool] = useState<PaintTool>("fill");
  const [isInitializing, setIsInitializing] = useState(true);

  const originalImageDataRef = useRef<ImageData | null>(null);
  const filledMaskRef = useRef<Uint8Array | null>(null);
  const maskHistoryRef = useRef<Uint8Array[]>([]);
  const cachedEdgeMapRef = useRef<Uint8Array | null>(null);
  const cutoutMaskRef = useRef<Uint8Array | null>(null);
  const regionLabelsRef = useRef<Int32Array | null>(null);
  const regionSeedsRef = useRef<Map<number, { x: number; y: number }> | null>(null);

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
  const adjustDragRef = useRef<{
    type: "edge" | "vertex";
    outlineIndex: number;
    edgeIndex?: number;
    vertexIndex?: number;
    startX: number;
    startY: number;
    originalOutlines: Point[][];
    originalHoles: Point[][];
  } | null>(null);
  const interiorHolesRef = useRef<Point[][]>([]);

  const emitOutlinesAndHoles = useCallback((mask: Uint8Array, w: number, h: number) => {
    const outlines = extractMultipleOutlines(mask, w, h);
    onOutlinesExtracted(outlines);
    if (onHolesExtracted) {
      const holes = extractInteriorHoles(mask, w, h);
      interiorHolesRef.current = holes;
      onHolesExtracted(holes);
    }
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

    // Defer heavy edge/region computation to next frame
    setIsInitializing(true);
    requestAnimationFrame(() => {
      const imgData = originalImageDataRef.current!;
      const edgeMap = buildEdgeMap(imgData.data, canvas.width, canvas.height);
      cachedEdgeMapRef.current = edgeMap;

      // Build region map in a second frame to avoid long blocking
      requestAnimationFrame(() => {
        const { regionLabels, regionSeeds } = buildRegionMap(
          imgData.data, canvas.width, canvas.height, edgeMap, 45
        );
        regionLabelsRef.current = regionLabels;
        regionSeedsRef.current = regionSeeds;
        setIsInitializing(false);
      });
    });
  }, [pdfCanvas, calculateFitScale]);

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

    if (filledMaskRef.current) {
      if (!overlayCanvasRef.current || overlayCanvasRef.current.width !== width || overlayCanvasRef.current.height !== height) {
        overlayCanvasRef.current = document.createElement("canvas");
        overlayCanvasRef.current.width = width;
        overlayCanvasRef.current.height = height;
      }
      const offCtx = overlayCanvasRef.current.getContext("2d")!;
      const overlayData = offCtx.createImageData(width, height);
      const mask = filledMaskRef.current;
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
    for (let oi = 0; oi < roofOutlines.length; oi++) {
      const outline = roofOutlines[oi];
      if (outline.length <= 2) continue;

      // Draw each edge individually to support highlighting
      for (let ei = 0; ei < outline.length; ei++) {
        const p1 = outline[ei];
        const p2 = outline[(ei + 1) % outline.length];
        const isHovered = activeTool === "adjust" &&
          hoveredEdge?.outlineIndex === oi &&
          hoveredEdge?.edgeIndex === ei;

        ctx.strokeStyle = isHovered ? "hsl(210, 85%, 55%)" : "hsl(0, 85%, 50%)";
        ctx.lineWidth = isHovered ? 5 : 3;
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
        ctx.arc(pt.x, pt.y, isVertexHovered ? 7 : 4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [roofOutlines, activeTool, hoveredEdge, hoveredVertex]);

  useEffect(() => { redrawCanvas(); }, [roofOutlines, fillCount, redrawCanvas, hoveredEdge]);

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
        eraseFill(tempMask, w, h, hx, hy, origData, 40);
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

      const result = floodFillPreview(origData.data, w, h, hx, hy, edgeMap, currentMask || undefined, 45);
      if (result.filledPixelCount < 50) { clearPreview(); isComputingRef.current = false; return; }

      const previewMask = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) {
        if (result.filledMask[i] && (!currentMask || !currentMask[i])) previewMask[i] = 1;
      }
      renderPreviewMask(previewMask, PREVIEW_FILL_COLOR);
      isComputingRef.current = false;
    });
  }, [activeTool, clearPreview, renderPreviewMask]);

  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = Math.round((e.clientX - rect.left) / displayScale);
    const y = Math.round((e.clientY - rect.top) / displayScale);
    if (x < 0 || x >= canvas.width || y < 0 || y >= canvas.height) return null;
    return { x, y };
  }, [displayScale]);

  const fillAtPoint = useCallback((x: number, y: number): boolean => {
    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current) return false;
    const w = canvas.width, h = canvas.height;
    const origData = originalImageDataRef.current;
    const currentMask = filledMaskRef.current;

    if (currentMask && currentMask[y * w + x]) return false;
    if (cutoutMaskRef.current && cutoutMaskRef.current[y * w + x]) return false;

    const imageData = new ImageData(new Uint8ClampedArray(origData.data), w, h);
    const result = floodFill(imageData, x, y, FILL_COLOR, currentMask || undefined, 45, true);
    if (result.filledPixelCount < 50) return false;

    const cutout = cutoutMaskRef.current;
    if (cutout) {
      for (let i = 0; i < w * h; i++) {
        if (cutout[i]) result.filledMask[i] = 0;
      }
    }

    filledMaskRef.current = result.filledMask;
    return true;
  }, []);

  // --- Rectangle drag for multi-select ---
  const getRegionsInRect = useCallback((x1: number, y1: number, x2: number, y2: number, w: number): Set<number> => {
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
  }, []);

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

  // --- Mouse handlers ---
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || isInitializing) return;
    const pos = getCanvasPos(e);
    if (!pos) return;

    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current) return;
    const w = canvas.width;
    const currentMask = filledMaskRef.current;

    // Adjust tool: start dragging an edge
    if (activeTool === "adjust") {
      // Check vertex first (higher priority, smaller target)
      const vertex = findClosestVertex(pos.x, pos.y, roofOutlines, 10);
      if (vertex) {
        if (currentMask) maskHistoryRef.current.push(new Uint8Array(currentMask));
        adjustDragRef.current = {
          type: "vertex",
          outlineIndex: vertex.outlineIndex,
          vertexIndex: vertex.vertexIndex,
          startX: pos.x,
          startY: pos.y,
          originalOutlines: roofOutlines.map(o => o.map(p => ({ ...p }))),
          originalHoles: interiorHolesRef.current.map(h => h.map(p => ({ ...p }))),
        };
        return;
      }
      const edge = findClosestEdge(pos.x, pos.y, roofOutlines, 15);
      if (edge) {
        if (currentMask) maskHistoryRef.current.push(new Uint8Array(currentMask));
        adjustDragRef.current = {
          type: "edge",
          outlineIndex: edge.outlineIndex,
          edgeIndex: edge.edgeIndex,
          startX: pos.x,
          startY: pos.y,
          originalOutlines: roofOutlines.map(o => o.map(p => ({ ...p }))),
          originalHoles: interiorHolesRef.current.map(h => h.map(p => ({ ...p }))),
        };
      }
      return;
    }

    if (activeTool === "fill" && (!currentMask || !currentMask[pos.y * w + pos.x])) {
      dragStartRef.current = pos;
      dragCurrentRef.current = pos;
      isDraggingRef.current = true;
      justDraggedRef.current = false;

      dragMaskBeforeRef.current = currentMask ? new Uint8Array(currentMask) : new Uint8Array(0);
      clearPreview();
      return;
    }
  }, [getCanvasPos, activeTool, clearPreview, isInitializing, roofOutlines]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isInitializing) return;
    const pos = getCanvasPos(e);
    if (!pos) return;

    // Adjust tool: drag edge or highlight edge on hover
    if (activeTool === "adjust") {
      const drag = adjustDragRef.current;
      if (drag) {
        let dx = pos.x - drag.startX;
        let dy = pos.y - drag.startY;

        if (drag.type === "vertex") {
          let newX = drag.originalOutlines[drag.outlineIndex][drag.vertexIndex!].x + dx;
          let newY = drag.originalOutlines[drag.outlineIndex][drag.vertexIndex!].y + dy;

          // Shift key snaps vertex so both edges are axis-aligned (horizontal/vertical)
          if (e.shiftKey) {
            const outline = drag.originalOutlines[drag.outlineIndex];
            const n = outline.length;
            const vi = drag.vertexIndex!;
            const prev = outline[(vi - 1 + n) % n];
            const next = outline[(vi + 1) % n];
            // Snap to the intersection of axis-aligned lines from prev and next
            // Pick the combo (prev.x/next.y or next.x/prev.y) closest to mouse
            const opt1 = { x: prev.x, y: next.y }; // horizontal from next, vertical from prev
            const opt2 = { x: next.x, y: prev.y }; // horizontal from prev, vertical from next
            const d1 = Math.hypot(newX - opt1.x, newY - opt1.y);
            const d2 = Math.hypot(newX - opt2.x, newY - opt2.y);
            if (d1 < d2) {
              newX = opt1.x;
              newY = opt1.y;
            } else {
              newX = opt2.x;
              newY = opt2.y;
            }
          }
          const newOutlines = drag.originalOutlines.map((outline, oi) => {
            if (oi === drag.outlineIndex) {
              return outline.map((p, vi) => {
                if (vi === drag.vertexIndex) {
                  return { x: Math.round(newX), y: Math.round(newY) };
                }
                return { ...p };
              });
            }
            return outline;
          });
          const canvas = canvasRef.current!;
          const w = canvas.width, h = canvas.height;
          const newMask = rasterizeOutlinesWithHoles(newOutlines, drag.originalHoles, w, h);
          filledMaskRef.current = newMask;
          onOutlinesExtracted(newOutlines);
          redrawCanvas();
        } else {
          // Edge drag (existing behavior)
          const newOutlines = drag.originalOutlines.map((outline, oi) => {
            if (oi === drag.outlineIndex) {
              return movePolygonEdge(outline, drag.edgeIndex!, dx, dy);
            }
            return outline;
          });
          const canvas = canvasRef.current!;
          const w = canvas.width, h = canvas.height;
          const newMask = rasterizeOutlinesWithHoles(newOutlines, drag.originalHoles, w, h);
          filledMaskRef.current = newMask;
          onOutlinesExtracted(newOutlines);
          redrawCanvas();
        }
      } else {
        // Hover highlight — check vertex first, then edge
        const vertex = findClosestVertex(pos.x, pos.y, roofOutlines, 10);
        if (vertex) {
          setHoveredVertex({ outlineIndex: vertex.outlineIndex, vertexIndex: vertex.vertexIndex });
          setHoveredEdge(null);
        } else {
          setHoveredVertex(null);
          const edge = findClosestEdge(pos.x, pos.y, roofOutlines, 15);
          setHoveredEdge(edge ? { outlineIndex: edge.outlineIndex, edgeIndex: edge.edgeIndex } : null);
        }
      }
      return;
    }

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
  }, [getCanvasPos, displayScale, computePreview, activeTool, renderRectPreview, isInitializing, roofOutlines, redrawCanvas, onOutlinesExtracted]);

  const handleMouseUp = useCallback(() => {
    // Adjust tool: finalize edge drag
    if (adjustDragRef.current) {
      adjustDragRef.current = null;
      const canvas = canvasRef.current;
      if (canvas && filledMaskRef.current) {
        setFillCount(c => c + 1);
        // Don't re-extract outlines from mask — the current roofOutlines are already
        // the clean adjusted polygons. Only re-extract holes.
        if (onHolesExtracted) {
          const holes = extractInteriorHoles(filledMaskRef.current, canvas.width, canvas.height);
          interiorHolesRef.current = holes;
          onHolesExtracted(holes);
        }
      }
      return;
    }

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
        if (beforeMask) maskHistoryRef.current.push(beforeMask);
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
      if (beforeMask) maskHistoryRef.current.push(beforeMask);
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
  }, [onOutlinesExtracted, clearPreview, redrawCanvas, getRegionsInRect, buildRegionPreviewMask, fillAtPoint]);

  const handleMouseLeave = useCallback(() => {
    if (adjustDragRef.current) handleMouseUp();
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

    // Save mask for undo
    const currentMask = filledMaskRef.current;
    if (currentMask) maskHistoryRef.current.push(new Uint8Array(currentMask));

    // Remove the second vertex of the edge; the polygon reconnects automatically
    const vertexToRemove = (edge.edgeIndex + 1) % outline.length;
    const newOutline = outline.filter((_, i) => i !== vertexToRemove);

    const newOutlines = roofOutlines.map((o, oi) =>
      oi === edge.outlineIndex ? newOutline : o
    );

    // Rasterize new mask
    const canvas = canvasRef.current;
    if (canvas) {
      const w = canvas.width, h = canvas.height;
      const newMask = rasterizeOutlinesWithHoles(newOutlines, interiorHolesRef.current, w, h);
      filledMaskRef.current = newMask;
    }

    onOutlinesExtracted(newOutlines);
    setHoveredEdge(null);
    setHoveredVertex(null);
    setFillCount(c => c + 1);
  }, [activeTool, getCanvasPos, roofOutlines, onOutlinesExtracted]);

  useEffect(() => { clearPreview(); setHoveredEdge(null); setHoveredVertex(null); }, [activeTool, clearPreview]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (justDraggedRef.current || isInitializing || activeTool === "adjust") return;
    const pos = getCanvasPos(e);
    if (!pos) return;
    const canvas = canvasRef.current;
    if (!canvas || !originalImageDataRef.current) return;

    const origData = originalImageDataRef.current;
    const w = canvas.width, h = canvas.height;
    const currentMask = filledMaskRef.current;

    if (activeTool === "cutout") {
      if (!currentMask || !currentMask[pos.y * w + pos.x]) return;
      maskHistoryRef.current.push(new Uint8Array(currentMask));
      const beforeMask = new Uint8Array(currentMask);
      eraseFill(currentMask, w, h, pos.x, pos.y, origData, 40);

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
      maskHistoryRef.current.push(new Uint8Array(currentMask));
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
  }, [getCanvasPos, emitOutlinesAndHoles, activeTool, clearPreview, isInitializing]);

  const handleUndo = useCallback(() => {
    if (maskHistoryRef.current.length === 0) return;
    const previousMask = maskHistoryRef.current.pop()!;
    cutoutMaskRef.current = null;
    if (previousMask.length === 0) {
      filledMaskRef.current = null;
      setFillCount(0);
      onOutlinesExtracted([]);
      if (onHolesExtracted) onHolesExtracted([]);
    } else {
      filledMaskRef.current = previousMask;
      setFillCount(c => c - 1);
      const canvas = canvasRef.current;
      if (canvas) {
        emitOutlinesAndHoles(previousMask, canvas.width, canvas.height);
      }
    }
    clearPreview();
  }, [emitOutlinesAndHoles, onOutlinesExtracted, onHolesExtracted, clearPreview]);

  const handleReset = useCallback(() => {
    filledMaskRef.current = null;
    cutoutMaskRef.current = null;
    maskHistoryRef.current = [];
    setFillCount(0);
    onOutlinesExtracted([]);
    if (onHolesExtracted) onHolesExtracted([]);
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
      <div className="flex items-center gap-2 mb-2 px-1">
        <div className="flex items-center border border-border rounded-md overflow-hidden">
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
            variant={activeTool === "adjust" ? "default" : "ghost"}
            size="sm"
            onClick={() => setActiveTool("adjust")}
            title="Adjust boundary edges"
            className="rounded-none"
            disabled={isInitializing || !hasAnyFill}
          >
            <Move className="w-4 h-4 mr-1" />
            Adjust
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

      {/* Canvas area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-auto border border-border rounded-lg bg-muted/30"
        onWheel={handleWheel as any}
      >
        <div className="min-w-fit min-h-fit p-2 relative">
          <canvas ref={canvasRef} className="block mx-auto" />
          <canvas
            ref={previewCanvasRef}
            onClick={handleCanvasClick}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onContextMenu={handleContextMenu}
            className={`absolute top-2 left-1/2 -translate-x-1/2 ${activeTool === "adjust" ? "cursor-move" : activeTool === "cutout" ? "cursor-pointer" : "cursor-crosshair"}`}
            style={{ pointerEvents: "auto" }}
          />
        </div>
      </div>

      <div className="flex items-center justify-center gap-2 mt-2 px-4">
        <MousePointer className="w-3.5 h-3.5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">
          {activeTool === "adjust"
            ? "Drag edges or vertices to adjust — hold Shift to lock to 90° — right-click edge to delete — Ctrl + scroll to zoom"
            : activeTool === "fill"
            ? "Hover to preview — click or hold & drag to multi-select areas — click filled area to remove — Ctrl + scroll to zoom"
            : "Hover to preview — click inside a filled area to cut out a section — Ctrl + scroll to zoom"}
        </p>
      </div>
    </div>
  );
};
