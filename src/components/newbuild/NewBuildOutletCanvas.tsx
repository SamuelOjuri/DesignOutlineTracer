import { useRef, useEffect, useState, useCallback } from "react";
import { Point, Outlet, DrainageEdge } from "@/types/roof";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";
import { insulationPolygons } from "@/utils/penetrationOpenings";
import { drawOutletMarker, outletMarkerGeometry, OUTLET_HIT_RADIUS } from "@/utils/outletMarker";

interface NewBuildOutletCanvasProps {
  pdfCanvas: HTMLCanvasElement;
  roofOutlines: Point[][];
  outlineIds?: string[];
  interiorHoles?: Point[][];
  outlets: Outlet[];
  selectedOutlet: Outlet | null;
  onAddOutlet: (x: number, y: number) => void;
  onSelectOutlet: (outlet: Outlet | null) => void;
  onMoveOutlet: (id: string, x: number, y: number) => void;
  drainageEdges: DrainageEdge[];
  onToggleDrainageEdge: (outlineIndex: number, edgeIndex: number) => void;
  outletMode: 'select' | 'add-outlets' | 'drainage-edge';
}

export const NewBuildOutletCanvas = ({
  pdfCanvas,
  roofOutlines,
  outlineIds = [],
  interiorHoles = [],
  outlets,
  selectedOutlet,
  onAddOutlet,
  onSelectOutlet,
  onMoveOutlet,
  drainageEdges,
  onToggleDrainageEdge,
  outletMode,
}: NewBuildOutletCanvasProps) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [fitScale, setFitScale] = useState(1);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [dragPreview, setDragPreview] = useState<(Point & { id: string }) | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<{ outlineIndex: number; edgeIndex: number } | null>(null);
  const dragOutlet = useRef<Outlet | null>(null);
  const dragPosition = useRef<Point | null>(null);
  const zoomTarget = useRef<Point | null>(null);

  const ZOOM_STEP = 0.15;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;
  const EDGE_HIT_DISTANCE = 12; // pixels tolerance for clicking an edge

  const cancelDrag = useCallback(() => {
    dragOutlet.current = null;
    dragPosition.current = null;
    setDragPreview(null);
    setIsDragging(false);
  }, []);

  useEffect(() => { cancelDrag(); }, [pdfCanvas, outletMode, cancelDrag]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragOutlet.current) {
        event.preventDefault();
        cancelDrag();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", cancelDrag);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", cancelDrag);
    };
  }, [cancelDrag]);

  const calculateFitScale = useCallback(() => {
    if (!containerRef.current || !pdfCanvas) return 1;
    const containerWidth = containerRef.current.clientWidth - 16;
    const containerHeight = containerRef.current.clientHeight - 16;
    return Math.max(0.01, Math.min(containerWidth / pdfCanvas.width, containerHeight / pdfCanvas.height));
  }, [pdfCanvas]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfCanvas) return;
    const fit = calculateFitScale();
    setFitScale(fit);
    setDisplayScale(fit);
    canvas.width = pdfCanvas.width;
    canvas.height = pdfCanvas.height;
    canvas.style.width = `${pdfCanvas.width * fit}px`;
    canvas.style.height = `${pdfCanvas.height * fit}px`;
  }, [pdfCanvas, calculateFitScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfCanvas) return;
    canvas.style.width = `${pdfCanvas.width * displayScale}px`;
    canvas.style.height = `${pdfCanvas.height * displayScale}px`;
    if (zoomTarget.current && containerRef.current) {
      const container = containerRef.current;
      const target = zoomTarget.current;
      // offsetLeft includes the centred canvas margin when the page is narrower than its viewport.
      container.scrollLeft = Math.max(0, canvas.offsetLeft + target.x * displayScale - container.clientWidth / 2);
      container.scrollTop = Math.max(0, canvas.offsetTop + target.y * displayScale - container.clientHeight / 2);
      zoomTarget.current = null;
    }
  }, [displayScale, pdfCanvas]);

  useEffect(() => {
    const handleResize = () => {
      const fit = calculateFitScale();
      setFitScale(fit);
      setDisplayScale(fit);
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [calculateFitScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfCanvas) return;
    const ctx = canvas.getContext("2d")!;
    const isDrainageEdge = (outlineIndex: number, edgeIndex: number) =>
      drainageEdges.some((edge) => edge.outlineIndex === outlineIndex && edge.edgeIndex === edgeIndex);

    ctx.drawImage(pdfCanvas, 0, 0);

    // Draw all roof outlines with edge highlighting
    for (let oi = 0; oi < roofOutlines.length; oi++) {
      const outline = roofOutlines[oi];
      if (outline.length < 3) continue;

      // Subtract the union of openings before drawing, so overlaps stay empty.
      ctx.beginPath();
      for (const polygon of insulationPolygons([outline], interiorHoles)) {
        for (const ring of polygon) {
          ctx.moveTo(ring[0][0], ring[0][1]);
          for (const [x, y] of ring.slice(1)) ctx.lineTo(x, y);
          ctx.closePath();
        }
      }
      ctx.fillStyle = "hsla(0, 85%, 50%, 0.08)";
      ctx.fill("evenodd");

      // Draw each edge individually
      for (let ei = 0; ei < outline.length; ei++) {
        const p1 = outline[ei];
        const p2 = outline[(ei + 1) % outline.length];
        const isDrainage = isDrainageEdge(oi, ei);
        const isHovered =
          outletMode === "drainage-edge" &&
          hoveredEdge?.outlineIndex === oi &&
          hoveredEdge?.edgeIndex === ei;

        if (isDrainage) {
          ctx.strokeStyle = "hsl(210, 85%, 50%)";
          ctx.lineWidth = 5;
        } else if (isHovered) {
          ctx.strokeStyle = "hsl(210, 85%, 65%)";
          ctx.lineWidth = 4;
        } else {
          ctx.strokeStyle = "hsl(0, 85%, 50%)";
          ctx.lineWidth = 3;
        }

        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        // Draw drainage arrows
        if (isDrainage) {
          drawDrainageArrows(ctx, p1, p2);
        }
      }
    }

    // Draw interior holes once, regardless of how many roof outlines exist.
    for (const hole of interiorHoles) {
      if (hole.length < 3) continue;
      ctx.fillStyle = "hsla(0, 0%, 50%, 0.15)";
      ctx.strokeStyle = "hsl(0, 0%, 40%)";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(hole[0].x, hole[0].y);
      for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Draw outlets
    outlets.forEach((outlet) => {
      const preview = dragPreview?.id === outlet.id ? { ...outlet, ...dragPreview } : outlet;
      drawOutletMarker(ctx, preview, outletMarkerGeometry(preview, roofOutlines, interiorHoles,
        displayScale, outlineIds, 5), selectedOutlet?.id === outlet.id);
    });
  }, [pdfCanvas, roofOutlines, outlineIds, interiorHoles, outlets, selectedOutlet, drainageEdges, hoveredEdge, outletMode, displayScale, dragPreview]);

  const drawDrainageArrows = (ctx: CanvasRenderingContext2D, p1: Point, p2: Point) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;

    const nx = dx / len;
    const ny = dy / len;
    // Perpendicular outward (clockwise assumption)
    const px = ny;
    const py = -nx;

    const arrowSpacing = 30;
    const numArrows = Math.max(1, Math.floor(len / arrowSpacing));

    ctx.strokeStyle = "hsl(210, 85%, 50%)";
    ctx.lineWidth = 2;

    for (let i = 0; i < numArrows; i++) {
      const t = (i + 0.5) / numArrows;
      const ax = p1.x + dx * t;
      const ay = p1.y + dy * t;
      const arrowLen = 12;
      const ex = ax + px * arrowLen;
      const ey = ay + py * arrowLen;

      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(ex, ey);
      ctx.stroke();

      const headLen = 4;
      const angle = Math.atan2(py, px);
      const ha = Math.PI / 6;
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - headLen * Math.cos(angle - ha), ey - headLen * Math.sin(angle - ha));
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - headLen * Math.cos(angle + ha), ey - headLen * Math.sin(angle + ha));
      ctx.stroke();
    }
  };

  const getCanvasCoords = (e: React.MouseEvent) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) / displayScale,
      y: (e.clientY - rect.top) / displayScale,
    };
  };

  const findEdgeAt = (x: number, y: number): { outlineIndex: number; edgeIndex: number } | null => {
    for (let oi = 0; oi < roofOutlines.length; oi++) {
      const outline = roofOutlines[oi];
      if (outline.length < 3) continue;
      for (let ei = 0; ei < outline.length; ei++) {
        const p1 = outline[ei];
        const p2 = outline[(ei + 1) % outline.length];
        const dist = pointToSegmentDistance(x, y, p1.x, p1.y, p2.x, p2.y);
        if (dist < EDGE_HIT_DISTANCE / displayScale) return { outlineIndex: oi, edgeIndex: ei };
      }
    }
    return null;
  };

  const pointToSegmentDistance = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.sqrt((px - ax) ** 2 + (py - ay) ** 2);
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const projX = ax + t * dx;
    const projY = ay + t * dy;
    return Math.sqrt((px - projX) ** 2 + (py - projY) ** 2);
  };

  const findOutletAt = (x: number, y: number): Outlet | null => {
    let closest: Outlet | null = null;
    let nearestDistance = OUTLET_HIT_RADIUS / displayScale;
    for (const outlet of outlets) {
      const dist = Math.sqrt((outlet.x - x) ** 2 + (outlet.y - y) ** 2);
      if (dist < nearestDistance) { closest = outlet; nearestDistance = dist; }
    }
    return closest;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const { x, y } = getCanvasCoords(e);

    if (outletMode === "drainage-edge") {
      const edge = findEdgeAt(x, y);
      if (edge) {
        onToggleDrainageEdge(edge.outlineIndex, edge.edgeIndex);
      }
      return;
    }

    // Outlet mode
    const clicked = findOutletAt(x, y);
    if (clicked) {
      onSelectOutlet(clicked);
      dragOutlet.current = clicked;
      dragPosition.current = { x: clicked.x, y: clicked.y };
      setIsDragging(true);
      setDragOffset({ x: x - clicked.x, y: y - clicked.y });
    } else {
      onSelectOutlet(null);
      if (outletMode === "add-outlets") onAddOutlet(x, y);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = getCanvasCoords(e);

    if (outletMode === "drainage-edge") {
      const edge = findEdgeAt(x, y);
      setHoveredEdge(edge);
      return;
    }

    if (!isDragging || !dragOutlet.current) return;
    const position = { x: x - dragOffset.x, y: y - dragOffset.y };
    dragPosition.current = position;
    setDragPreview({ id: dragOutlet.current.id, ...position });
  };

  const handleMouseUp = () => {
    const original = dragOutlet.current;
    const position = dragPosition.current;
    cancelDrag();
    // One gesture creates one review/history update; previews never mutate source coordinates.
    if (original && position && outlets.some(outlet => outlet.id === original.id)
      && (position.x !== original.x || position.y !== original.y)) {
      onMoveOutlet(original.id, position.x, position.y);
    }
  };

  const handleZoomIn = () => setDisplayScale((s) => Math.min(s + ZOOM_STEP, MAX_ZOOM));
  const handleZoomOut = () => setDisplayScale((s) => Math.max(s - ZOOM_STEP, MIN_ZOOM));
  const handleFitToScreen = () => setDisplayScale(fitScale);
  const handleZoomToOutlet = () => {
    if (!selectedOutlet) return;
    const geometry = outletMarkerGeometry(selectedOutlet, roofOutlines, interiorHoles, displayScale, outlineIds, 5);
    const available = geometry.clearance - 2.5;
    const targetScale = geometry.status === "interior" && available > 0 ? 13 / available : 1;
    zoomTarget.current = selectedOutlet;
    const nextScale = Math.min(MAX_ZOOM, Math.max(displayScale, 1, targetScale));
    // Recenter even when the selected outlet is already at the desired zoom.
    if (nextScale === displayScale && containerRef.current && canvasRef.current) {
      const canvas = canvasRef.current, container = containerRef.current;
      container.scrollLeft = Math.max(0, canvas.offsetLeft + selectedOutlet.x * displayScale - container.clientWidth / 2);
      container.scrollTop = Math.max(0, canvas.offsetTop + selectedOutlet.y * displayScale - container.clientHeight / 2);
      zoomTarget.current = null;
    } else setDisplayScale(nextScale);
  };
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
      <div className="flex flex-wrap items-center gap-2 mb-2 px-1">
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
        {selectedOutlet && <Button variant="outline" size="sm" onClick={handleZoomToOutlet}>Zoom to outlet</Button>}
      </div>

      <div
        ref={containerRef}
        className="flex-1 overflow-auto border border-border rounded-lg bg-muted/30"
        onWheel={handleWheel}
      >
        <div className="min-w-fit min-h-fit p-2">
          <canvas
            ref={canvasRef}
            aria-label="Roof outlet placement"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
              handleMouseUp();
              setHoveredEdge(null);
            }}
            className={`block mx-auto ${outletMode === "drainage-edge" ? "cursor-pointer" : outletMode === "select" ? "cursor-default" : "cursor-crosshair"}`}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-1 text-center">
        {outletMode === "drainage-edge"
          ? "Click roof edges to mark/unmark as drainage edges"
          : outletMode === "select" ? "Select an outlet to review or drag it to correct its position. Ctrl + scroll to zoom."
          : "Click to place outlets • Drag to reposition • Ctrl + scroll to zoom"}
      </p>
    </div>
  );
};
