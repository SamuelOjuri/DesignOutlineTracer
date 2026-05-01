import { useRef, useEffect, useState, useCallback } from "react";
import { Point, Outlet, DrainageEdge } from "@/types/roof";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize, Move, MousePointer } from "lucide-react";

interface RoofIllustrationCanvasProps {
  roofOutlines: Point[][];
  interiorHoles?: Point[][];
  outlets: Outlet[];
  drainageEdges: DrainageEdge[];
  onOutlinesChange?: (outlines: Point[][]) => void;
  onHolesChange?: (holes: Point[][]) => void;
  onOutletsChange?: (outlets: Outlet[]) => void;
}

export const RoofIllustrationCanvas = ({
  roofOutlines,
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
  const PADDING = 60;

  const getBounds = useCallback(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const outline of roofOutlines) {
      for (const p of outline) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    for (const o of outlets) {
      minX = Math.min(minX, o.x - 20);
      minY = Math.min(minY, o.y - 20);
      maxX = Math.max(maxX, o.x + 20);
      maxY = Math.max(maxY, o.y + 20);
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 400, maxY: 300, w: 400, h: 300 };
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
  }, [roofOutlines, outlets]);

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
    const fit = Math.min(containerW / canvasW, containerH / canvasH, 1.5);
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
    draw();
  }, [roofOutlines, interiorHoles, outlets, drainageEdges, displayScale, hoveredOutline]);

  const isDrainageEdge = (oi: number, ei: number) =>
    drainageEdges.some((d) => d.outlineIndex === oi && d.edgeIndex === ei);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const offset = getOffset();

    // Clear with white
    ctx.fillStyle = "hsl(0, 0%, 100%)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Subtle grid
    ctx.strokeStyle = "hsl(0, 0%, 93%)";
    ctx.lineWidth = 0.5;
    const gridSize = 40;
    for (let x = 0; x < canvas.width; x += gridSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += gridSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }

    // Draw roof outlines
    for (let oi = 0; oi < roofOutlines.length; oi++) {
      const outline = roofOutlines[oi];
      if (outline.length < 3) continue;
      const isHovered = hoveredOutline === oi;

      // Fill
      ctx.fillStyle = isHovered ? "hsla(210, 80%, 90%, 0.6)" : "hsla(0, 0%, 95%, 0.8)";
      ctx.beginPath();
      ctx.moveTo(outline[0].x + offset.x, outline[0].y + offset.y);
      for (let i = 1; i < outline.length; i++) {
        ctx.lineTo(outline[i].x + offset.x, outline[i].y + offset.y);
      }
      ctx.closePath();
      ctx.fill();

      // Hovered outline border
      if (isHovered) {
        ctx.strokeStyle = "hsl(210, 85%, 55%)";
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Draw each edge
      for (let ei = 0; ei < outline.length; ei++) {
        const p1 = outline[ei];
        const p2 = outline[(ei + 1) % outline.length];
        const drainage = isDrainageEdge(oi, ei);

        if (drainage) {
          ctx.strokeStyle = "hsl(210, 85%, 50%)";
          ctx.lineWidth = 4;
        } else {
          ctx.strokeStyle = "hsl(220, 15%, 30%)";
          ctx.lineWidth = 2.5;
        }

        ctx.beginPath();
        ctx.moveTo(p1.x + offset.x, p1.y + offset.y);
        ctx.lineTo(p2.x + offset.x, p2.y + offset.y);
        ctx.stroke();

        if (drainage) {
          drawDrainageArrows(ctx, { x: p1.x + offset.x, y: p1.y + offset.y }, { x: p2.x + offset.x, y: p2.y + offset.y });
        }

        ctx.fillStyle = "hsl(220, 15%, 30%)";
        ctx.beginPath();
        ctx.arc(p1.x + offset.x, p1.y + offset.y, 3, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    // Draw interior holes (penetrations)
    for (const hole of interiorHoles) {
      if (hole.length < 3) continue;
      ctx.fillStyle = "hsl(0, 0%, 100%)";
      ctx.strokeStyle = "hsl(0, 0%, 40%)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(hole[0].x + offset.x, hole[0].y + offset.y);
      for (let i = 1; i < hole.length; i++) {
        ctx.lineTo(hole[i].x + offset.x, hole[i].y + offset.y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw outlets
    outlets.forEach((outlet, idx) => {
      const ox = outlet.x + offset.x;
      const oy = outlet.y + offset.y;
      const radius = Math.max(10, (outlet.diameter / 2) * 100);

      ctx.beginPath();
      ctx.arc(ox, oy, radius, 0, 2 * Math.PI);
      ctx.fillStyle = "hsla(0, 75%, 55%, 0.25)";
      ctx.fill();
      ctx.strokeStyle = "hsl(0, 75%, 45%)";
      ctx.lineWidth = 2.5;
      ctx.stroke();

      ctx.strokeStyle = "hsl(0, 75%, 45%)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ox - 6, oy);
      ctx.lineTo(ox + 6, oy);
      ctx.moveTo(ox, oy - 6);
      ctx.lineTo(ox, oy + 6);
      ctx.stroke();

      ctx.fillStyle = "hsl(0, 75%, 40%)";
      ctx.font = "bold 11px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(`O${idx + 1}`, ox, oy - radius - 6);
    });

    // Legend
    drawLegend(ctx, canvas.width);
  }, [roofOutlines, outlets, drainageEdges, getBounds, hoveredOutline, interiorHoles]);

  const drawDrainageArrows = (ctx: CanvasRenderingContext2D, p1: Point, p2: Point) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;

    const nx = dx / len;
    const ny = dy / len;
    const px = ny;
    const py = -nx;

    const spacing = 30;
    const count = Math.max(1, Math.floor(len / spacing));

    ctx.strokeStyle = "hsl(210, 85%, 50%)";
    ctx.lineWidth = 1.5;

    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) / count;
      const ax = p1.x + dx * t;
      const ay = p1.y + dy * t;
      const aLen = 10;
      const ex = ax + px * aLen;
      const ey = ay + py * aLen;

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      const hl = 3.5;
      const angle = Math.atan2(py, px);
      const ha = Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - hl * Math.cos(angle - ha), ey - hl * Math.sin(angle - ha));
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - hl * Math.cos(angle + ha), ey - hl * Math.sin(angle + ha));
      ctx.stroke();
    }
  };

  const drawLegend = (ctx: CanvasRenderingContext2D, canvasWidth: number) => {
    const items: { color: string; label: string }[] = [
      { color: "hsl(220, 15%, 30%)", label: "Roof Edge" },
    ];
    if (drainageEdges.length > 0) {
      items.push({ color: "hsl(210, 85%, 50%)", label: "Drainage Edge" });
    }
    if (outlets.length > 0) {
      items.push({ color: "hsl(0, 75%, 45%)", label: "Outlet" });
    }

    const x = canvasWidth - 14;
    let y = 20;
    ctx.textAlign = "right";
    ctx.font = "11px system-ui, sans-serif";

    for (const item of items) {
      ctx.fillStyle = item.color;
      ctx.fillRect(x - ctx.measureText(item.label).width - 18, y - 6, 12, 12);
      ctx.fillStyle = "hsl(220, 15%, 25%)";
      ctx.fillText(item.label, x, y + 4);
      y += 20;
    }
  };

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onOutlinesChange || e.button !== 0) return;
    const pos = getCanvasPos(e);
    if (!pos) return;
    const oi = findOutlineAtPos(pos);
    if (oi === null) return;

    const outline = roofOutlines[oi];
    // Find outlets inside this outline
    const associatedOutletIds = outlets.filter(o =>
      isPointInPolygon(o.x, o.y, outline, 0, 0)
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
  }, [getCanvasPos, findOutlineAtPos, roofOutlines, onOutlinesChange, outlets, interiorHoles]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const pos = getCanvasPos(e);
    if (!pos) return;

    if (dragging && onOutlinesChange) {
      const dx = pos.x - dragging.startX;
      const dy = pos.y - dragging.startY;
      const newOutlines = roofOutlines.map((o, i) => {
        if (i === dragging.outlineIndex) {
          return dragging.originalOutline.map(p => ({
            x: Math.round(p.x + dx),
            y: Math.round(p.y + dy),
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
            return { ...o, x: Math.round(orig.x + dx), y: Math.round(orig.y + dy) };
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
              x: Math.round(p.x + dx),
              y: Math.round(p.y + dy),
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
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto border border-border rounded-lg bg-background"
        onWheel={handleWheel as any}
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
