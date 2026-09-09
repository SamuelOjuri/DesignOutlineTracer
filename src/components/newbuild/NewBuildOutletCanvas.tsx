import { useRef, useEffect, useState, useCallback } from "react";
import { Point, Outlet, DrainageEdge } from "@/types/roof";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, Maximize } from "lucide-react";

interface NewBuildOutletCanvasProps {
  pdfCanvas: HTMLCanvasElement;
  roofOutlines: Point[][];
  interiorHoles?: Point[][];
  outlets: Outlet[];
  selectedOutlet: Outlet | null;
  onAddOutlet: (x: number, y: number) => void;
  onSelectOutlet: (outlet: Outlet | null) => void;
  onMoveOutlet: (id: string, x: number, y: number) => void;
  drainageEdges: DrainageEdge[];
  onToggleDrainageEdge: (outlineIndex: number, edgeIndex: number) => void;
  outletMode: 'add-outlets' | 'drainage-edge';
}

export const NewBuildOutletCanvas = ({
  pdfCanvas,
  roofOutlines,
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
  const [hoveredEdge, setHoveredEdge] = useState<{ outlineIndex: number; edgeIndex: number } | null>(null);

  const ZOOM_STEP = 0.15;
  const MIN_ZOOM = 0.2;
  const MAX_ZOOM = 3;
  const EDGE_HIT_DISTANCE = 12; // pixels tolerance for clicking an edge

  const calculateFitScale = useCallback(() => {
    if (!containerRef.current || !pdfCanvas) return 1;
    const containerWidth = containerRef.current.clientWidth - 16;
    const containerHeight = containerRef.current.clientHeight - 16;
    return Math.min(containerWidth / pdfCanvas.width, containerHeight / pdfCanvas.height);
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
    draw();
  }, [pdfCanvas, calculateFitScale]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfCanvas) return;
    canvas.style.width = `${pdfCanvas.width * displayScale}px`;
    canvas.style.height = `${pdfCanvas.height * displayScale}px`;
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
    draw();
  }, [outlets, selectedOutlet, roofOutlines, interiorHoles, drainageEdges, hoveredEdge, outletMode]);

  const isDrainageEdge = (outlineIndex: number, edgeIndex: number) =>
    drainageEdges.some((d) => d.outlineIndex === outlineIndex && d.edgeIndex === edgeIndex);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !pdfCanvas) return;
    const ctx = canvas.getContext("2d")!;

    ctx.drawImage(pdfCanvas, 0, 0);

    // Draw all roof outlines with edge highlighting
    for (let oi = 0; oi < roofOutlines.length; oi++) {
      const outline = roofOutlines[oi];
      if (outline.length < 3) continue;

      // Fill roof area, cutting out interior holes using evenodd
      ctx.beginPath();
      ctx.moveTo(outline[0].x, outline[0].y);
      for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i].x, outline[i].y);
      ctx.closePath();
      // Add hole sub-paths (wound in same direction — evenodd will cut them out)
      for (const hole of interiorHoles) {
        if (hole.length < 3) continue;
        ctx.moveTo(hole[0].x, hole[0].y);
        for (let i = 1; i < hole.length; i++) ctx.lineTo(hole[i].x, hole[i].y);
        ctx.closePath();
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

    // Draw interior holes (penetrations)
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
    }

    // Draw outlets
    outlets.forEach((outlet) => {
      const isSelected = selectedOutlet?.id === outlet.id;
      const radius = Math.max(8, (outlet.diameter / 2) * 100);

      ctx.beginPath();
      ctx.arc(outlet.x, outlet.y, radius, 0, 2 * Math.PI);
      ctx.fillStyle = isSelected ? "hsla(0, 85%, 50%, 0.6)" : "hsla(0, 85%, 50%, 0.4)";
      ctx.fill();
      ctx.strokeStyle = isSelected ? "hsl(0, 85%, 40%)" : "hsl(0, 85%, 50%)";
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.stroke();

      ctx.strokeStyle = "white";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(outlet.x - 5, outlet.y);
      ctx.lineTo(outlet.x + 5, outlet.y);
      ctx.moveTo(outlet.x, outlet.y - 5);
      ctx.lineTo(outlet.x, outlet.y + 5);
      ctx.stroke();
    });
  }, [pdfCanvas, roofOutlines, outlets, selectedOutlet, drainageEdges, hoveredEdge, outletMode]);

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
      x: Math.round((e.clientX - rect.left) / displayScale),
      y: Math.round((e.clientY - rect.top) / displayScale),
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
        if (dist < EDGE_HIT_DISTANCE) return { outlineIndex: oi, edgeIndex: ei };
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
    for (const outlet of outlets) {
      const dist = Math.sqrt((outlet.x - x) ** 2 + (outlet.y - y) ** 2);
      if (dist < 15) return outlet;
    }
    return null;
  };

  const handleMouseDown = (e: React.MouseEvent) => {
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
      setIsDragging(true);
      setDragOffset({ x: x - clicked.x, y: y - clicked.y });
    } else {
      onSelectOutlet(null);
      onAddOutlet(x, y);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = getCanvasCoords(e);

    if (outletMode === "drainage-edge") {
      const edge = findEdgeAt(x, y);
      setHoveredEdge(edge);
      return;
    }

    if (!isDragging || !selectedOutlet) return;
    onMoveOutlet(selectedOutlet.id, x - dragOffset.x, y - dragOffset.y);
  };

  const handleMouseUp = () => setIsDragging(false);

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
        className="flex-1 overflow-auto border border-border rounded-lg bg-muted/30"
        onWheel={handleWheel as any}
      >
        <div className="min-w-fit min-h-fit p-2">
          <canvas
            ref={canvasRef}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => {
              handleMouseUp();
              setHoveredEdge(null);
            }}
            className={`block mx-auto ${outletMode === "drainage-edge" ? "cursor-pointer" : "cursor-crosshair"}`}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground mt-1 text-center">
        {outletMode === "drainage-edge"
          ? "Click roof edges to mark/unmark as drainage edges"
          : "Click to place outlets • Drag to reposition • Ctrl + scroll to zoom"}
      </p>
    </div>
  );
};
