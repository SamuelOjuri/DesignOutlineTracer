import { useRef, useEffect, useState, useCallback } from "react";
import { Point, Outlet, DrainageEdge } from "@/types/roof";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { outletMarkerGeometry } from "@/utils/outletMarker";
import { drawRoofIllustration, illustrationBounds, ILLUSTRATION_PADDING as PADDING } from "@/utils/roofRender";

interface RoofIllustrationCanvasProps {
  roofOutlines: Point[][];
  outlineIds?: string[];
  interiorHoles?: Point[][];
  outlets: Outlet[];
  drainageEdges: DrainageEdge[];
  onOutlinesChange?: (outlines: Point[][]) => void;
  onHolesChange?: (holes: Point[][]) => void;
  onOutletsChange?: (outlets: Outlet[]) => void;
}

export const RoofIllustrationCanvas = ({
  roofOutlines,
  outlineIds = [],
  interiorHoles = [],
  outlets,
  drainageEdges,
  onOutlinesChange,
  onHolesChange,
  onOutletsChange,
}: RoofIllustrationCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [hoveredOutline, setHoveredOutline] = useState<number | null>(null);
  const [dragging, setDragging] = useState<{
    outlineIndex: number;
    startX: number;
    startY: number;
    originalOutline: Point[];
    associatedOutletIds: string[];
    associatedHoleIndices: number[];
    originalOutlets: Outlet[];
    originalHoles: Point[][];
  } | null>(null);

  const ZOOM_STEP = 0.15;
  const MIN_ZOOM = 0.3;
  const MAX_ZOOM = 3;

  const getBounds = useCallback(() => illustrationBounds(roofOutlines, outlets), [roofOutlines, outlets]);

  const getOffset = useCallback(() => {
    const bounds = getBounds();
    return { x: PADDING - bounds.minX, y: PADDING - bounds.minY };
  }, [getBounds]);

  const getCanvasPos = useCallback((e: React.MouseEvent<HTMLCanvasElement>): Point | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const isPointInPolygon = (px: number, py: number, polygon: Point[], offX: number, offY: number): boolean => {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = polygon[i].x + offX, yi = polygon[i].y + offY;
      const xj = polygon[j].x + offX, yj = polygon[j].y + offY;
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  };

  const findOutlineAtPos = useCallback((pos: Point): number | null => {
    const offset = getOffset();
    for (let i = roofOutlines.length - 1; i >= 0; i--) {
      if (roofOutlines[i].length < 3) continue;
      if (isPointInPolygon(pos.x, pos.y, roofOutlines[i], offset.x, offset.y)) {
        return i;
      }
    }
    return null;
  }, [roofOutlines, getOffset]);

  const setupCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const bounds = getBounds();
    const canvasW = bounds.w + PADDING * 2;
    const canvasH = bounds.h + PADDING * 2;

    canvas.width = canvasW;
    canvas.height = canvasH;

    const containerW = container.clientWidth - 16;
    const containerH = container.clientHeight - 16;
    const fit = Math.max(0.01, Math.min(containerW / canvasW, containerH / canvasH, 1.5));
    setFitScale(fit);
    setDisplayScale(fit);

    canvas.style.width = `${canvasW * fit}px`;
    canvas.style.height = `${canvasH * fit}px`;
  }, [getBounds]);

  useEffect(() => {
    setupCanvas();
  }, [setupCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.style.width = `${canvas.width * displayScale}px`;
    canvas.style.height = `${canvas.height * displayScale}px`;
  }, [displayScale]);

  useEffect(() => {
    const handleResize = () => setupCanvas();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [setupCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    drawRoofIllustration(ctx, { roofOutlines, outlineIds, interiorHoles, outlets, drainageEdges },
      { offset: getOffset(), width: canvas.width, height: canvas.height, displayScale, hoveredOutline });
  }, [roofOutlines, outlineIds, outlets, drainageEdges, getOffset, hoveredOutline, interiorHoles, displayScale]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onOutlinesChange || e.button !== 0) return;
    const pos = getCanvasPos(e);
    if (!pos) return;
    const oi = findOutlineAtPos(pos);
    if (oi === null) return;

    const outline = roofOutlines[oi];
    // Explicit ownership also moves perimeter outlets whose centres are not strictly interior.
    const associatedOutletIds = outlets.filter(o => o.outline_id
      ? o.outline_id === outlineIds[oi]
      : outletMarkerGeometry(o, [outline], [], 1).status !== "outside"
    ).map(o => o.id);
    // Find holes inside this outline
    const associatedHoleIndices = interiorHoles.map((hole, idx) => {
      if (hole.length < 1) return -1;
      const cx = hole.reduce((s, p) => s + p.x, 0) / hole.length;
      const cy = hole.reduce((s, p) => s + p.y, 0) / hole.length;
      return isPointInPolygon(cx, cy, outline, 0, 0) ? idx : -1;
    }).filter(i => i >= 0);

    setDragging({
      outlineIndex: oi,
      startX: pos.x,
      startY: pos.y,
      originalOutline: outline.map(p => ({ ...p })),
      associatedOutletIds,
      associatedHoleIndices,
      originalOutlets: outlets.filter(o => associatedOutletIds.includes(o.id)).map(o => ({ ...o })),
      originalHoles: associatedHoleIndices.map(i => interiorHoles[i].map(p => ({ ...p }))),
    });
  }, [getCanvasPos, findOutlineAtPos, roofOutlines, outlineIds, onOutlinesChange, outlets, interiorHoles]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasPos(e);
    if (!pos) return;

    if (dragging && onOutlinesChange) {
      const dx = pos.x - dragging.startX;
      const dy = pos.y - dragging.startY;
      const newOutlines = roofOutlines.map((o, i) => {
        if (i === dragging.outlineIndex) {
          return dragging.originalOutline.map(p => ({
            x: p.x + dx,
            y: p.y + dy,
          }));
        }
        return o;
      });
      onOutlinesChange(newOutlines);

      // Move associated outlets
      if (onOutletsChange && dragging.associatedOutletIds.length > 0) {
        const newOutlets = outlets.map(o => {
          const origIdx = dragging.originalOutlets.findIndex(oo => oo.id === o.id);
          if (origIdx >= 0) {
            const orig = dragging.originalOutlets[origIdx];
            return { ...o, x: orig.x + dx, y: orig.y + dy };
          }
          return o;
        });
        onOutletsChange(newOutlets);
      }

      // Move associated holes
      if (onHolesChange && dragging.associatedHoleIndices.length > 0) {
        const newHoles = interiorHoles.map((h, idx) => {
          const dragIdx = dragging.associatedHoleIndices.indexOf(idx);
          if (dragIdx >= 0) {
            return dragging.originalHoles[dragIdx].map(p => ({
              x: p.x + dx,
              y: p.y + dy,
            }));
          }
          return h;
        });
        onHolesChange(newHoles);
      }
      return;
    }

    // Hover detection
    if (onOutlinesChange) {
      const oi = findOutlineAtPos(pos);
      setHoveredOutline(oi);
    }
  }, [getCanvasPos, dragging, roofOutlines, onOutlinesChange, findOutlineAtPos, outlets, onOutletsChange, interiorHoles, onHolesChange]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setDragging(null);
    setHoveredOutline(null);
  }, []);

  const handleZoomIn = () => setDisplayScale((s) => Math.min(s + ZOOM_STEP, MAX_ZOOM));
  const handleZoomOut = () => setDisplayScale((s) => Math.max(s - ZOOM_STEP, MIN_ZOOM));
  const handleFitToScreen = () => setDisplayScale(fitScale);
  const zoomPercent = Math.round((displayScale / fitScale) * 100);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
      setDisplayScale((s) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s + delta)));
    }
  }, []);

  return (
    <div className="flex flex-col h-full w-full">
      <div className="flex items-center gap-2 mb-2 px-1">
        <Button variant="outline" size="sm" onClick={handleZoomOut} title="Zoom out" aria-label="Zoom out">
          <ZoomOut className="w-4 h-4" />
        </Button>
        <span className="text-xs font-medium text-muted-foreground min-w-[48px] text-center">
          {zoomPercent}%
        </span>
        <Button variant="outline" size="sm" onClick={handleZoomIn} title="Zoom in" aria-label="Zoom in">
          <ZoomIn className="w-4 h-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={handleFitToScreen} title="Fit to screen" aria-label="Fit to screen">
          <Maximize className="w-4 h-4" />
        </Button>
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto border border-border rounded-lg bg-background"
        onWheel={handleWheel}
      >
        <div className="min-w-fit min-h-fit p-2">
          <canvas
            ref={canvasRef}
            className={`block mx-auto ${onOutlinesChange ? (hoveredOutline !== null || dragging ? "cursor-move" : "cursor-default") : ""}`}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-1 text-center">
        {onOutlinesChange
          ? "Drag roof areas to reposition them • Ctrl + scroll to zoom"
          : "Roof layout summary • Ctrl + scroll to zoom"}
      </p>
    </div>
  );
};
