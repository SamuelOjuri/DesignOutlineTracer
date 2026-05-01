import { useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { NewBuildStep, Outlet, Point, DrainageEdge } from "@/types/roof";
import { PaintBucket, MousePointerClick, Trash2, Droplets, Scissors, Move, Layers } from "lucide-react";

interface NewBuildSidebarProps {
  currentStep: NewBuildStep;
  roofOutlines: Point[][];
  outlets: Outlet[];
  selectedOutlet: Outlet | null;
  onDeleteOutlet: (id: string) => void;
  drainageEdges: DrainageEdge[];
  outletMode: 'add-outlets' | 'drainage-edge';
  onOutletModeChange: (mode: 'add-outlets' | 'drainage-edge') => void;
  savedOutlines?: Point[][];
  savedOutlets?: Outlet[];
}

const SavedAreasPreview = ({ outlines, outlets }: { outlines: Point[][]; outlets: Outlet[] }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || outlines.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const o of outlines) {
      for (const p of o) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
    const pad = 10;
    const w = maxX - minX || 1;
    const h = maxY - minY || 1;
    const scale = Math.min((canvas.width - pad * 2) / w, (canvas.height - pad * 2) / h);
    const offX = (canvas.width - w * scale) / 2 - minX * scale;
    const offY = (canvas.height - h * scale) / 2 - minY * scale;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const outline of outlines) {
      if (outline.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(outline[0].x * scale + offX, outline[0].y * scale + offY);
      for (let i = 1; i < outline.length; i++) {
        ctx.lineTo(outline[i].x * scale + offX, outline[i].y * scale + offY);
      }
      ctx.closePath();
      ctx.fillStyle = "hsla(210, 60%, 50%, 0.2)";
      ctx.fill();
      ctx.strokeStyle = "hsl(210, 60%, 50%)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    for (const o of outlets) {
      ctx.beginPath();
      ctx.arc(o.x * scale + offX, o.y * scale + offY, 4, 0, Math.PI * 2);
      ctx.fillStyle = "hsl(0, 70%, 50%)";
      ctx.fill();
    }
  }, [outlines, outlets]);

  return (
    <Card className="p-3 bg-muted/50 border-dashed">
      <div className="flex items-center gap-2 mb-2">
        <Layers className="w-4 h-4 text-primary" />
        <span className="text-xs font-semibold text-foreground">Previously Defined Areas</span>
      </div>
      <canvas
        ref={canvasRef}
        width={240}
        height={140}
        className="w-full rounded border border-border bg-background"
      />
      <p className="text-xs text-muted-foreground mt-1.5">
        {outlines.length} area{outlines.length !== 1 ? "s" : ""} from previous PDF
      </p>
    </Card>
  );
};

export const NewBuildSidebar = ({
  currentStep,
  roofOutlines,
  outlets,
  selectedOutlet,
  onDeleteOutlet,
  drainageEdges,
  outletMode,
  onOutletModeChange,
  savedOutlines = [],
  savedOutlets = [],
}: NewBuildSidebarProps) => {
  if (currentStep === "upload") {
    return null;
  }

  if (currentStep === "paint") {
    const hasOutlines = roofOutlines.length > 0 && roofOutlines.some((o) => o.length > 2);
    return (
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Define Roof Area</h3>
        <div className="space-y-4">
          {savedOutlines.length > 0 && (
            <SavedAreasPreview outlines={savedOutlines} outlets={savedOutlets} />
          )}
          <div className="p-3 bg-primary/10 border border-primary/20 rounded-lg">
            <div className="flex items-center gap-2 mb-2">
              <PaintBucket className="w-5 h-5 text-primary" />
              <span className="text-sm font-medium text-foreground">Select Roof Area</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Click inside any enclosed roof outline on the plan. The tool will
              automatically detect the boundary lines and fill the area.
            </p>
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <p className="flex items-start gap-2">
              <span className="text-primary font-bold mt-0.5">1</span>
              Click inside a closed roof shape to select it
            </p>
            <p className="flex items-start gap-2">
              <span className="text-primary font-bold mt-0.5">2</span>
              Click additional sections to add — adjacent areas merge automatically
            </p>
            <p className="flex items-start gap-2">
              <span className="text-primary font-bold mt-0.5">3</span>
              Click a filled area to remove it if selected by mistake
            </p>
            <p className="flex items-start gap-2">
              <span className="text-primary font-bold mt-0.5">4</span>
              Use <Scissors className="w-3.5 h-3.5 inline mx-0.5" /> <strong>Cut Out</strong> to remove sections within a filled area (e.g. penetrations)
            </p>
            <p className="flex items-start gap-2">
              <span className="text-primary font-bold mt-0.5">5</span>
              Use <Move className="w-3.5 h-3.5 inline mx-0.5" /> <strong>Adjust</strong> to drag boundary edges and fine-tune the outline
            </p>
          </div>

          {hasOutlines && (
            <div className="p-3 bg-muted rounded-lg border border-border">
              <p className="text-sm font-medium text-foreground mb-1">
                ✅ {roofOutlines.length} roof area{roofOutlines.length !== 1 ? "s" : ""} detected
              </p>
              <p className="text-xs text-muted-foreground">
                {roofOutlines.length > 1
                  ? "Separate areas will be treated as individual roofs."
                  : "Click additional sections to expand, or proceed to the next step."}
              </p>
            </div>
          )}

          <div className="p-3 bg-muted rounded-lg">
            <p className="text-xs text-muted-foreground">
              <strong>Tip:</strong> Multiple separate roofs on the plan will each get
              their own outline automatically. Use Undo or Reset in the toolbar above
              the canvas to correct mistakes.
            </p>
          </div>
        </div>
      </Card>
    );
  }

  if (currentStep === "outlets") {
    return (
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Outlets & Drainage</h3>
        <div className="space-y-4">
          {savedOutlines.length > 0 && (
            <SavedAreasPreview outlines={savedOutlines} outlets={savedOutlets} />
          )}
          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-2">
            <Button
              onClick={() => onOutletModeChange('add-outlets')}
              variant={outletMode === 'add-outlets' ? "default" : "outline"}
              className="flex-1"
            >
              <MousePointerClick className="w-4 h-4 mr-1" />
              Add Outlets
            </Button>
            <Button
              onClick={() => onOutletModeChange('drainage-edge')}
              variant={outletMode === 'drainage-edge' ? "default" : "outline"}
              className="flex-1"
            >
              <Droplets className="w-4 h-4 mr-1" />
              Drainage
            </Button>
          </div>

          {outletMode === 'add-outlets' && (
            <div className="p-3 bg-primary/10 border border-primary/20 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <MousePointerClick className="w-5 h-5 text-primary" />
                <span className="text-sm font-medium text-foreground">Click to Place</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Click on the roof plan to place outlet positions. Drag existing
                outlets to reposition them.
              </p>
            </div>
          )}

          {outletMode === 'drainage-edge' && (
            <div className="p-3 bg-accent/10 border border-accent/20 rounded-lg">
              <div className="flex items-center gap-2 mb-2">
                <Droplets className="w-5 h-5 text-accent-foreground" />
                <span className="text-sm font-medium text-foreground">Define Drainage Edges</span>
              </div>
              <p className="text-sm text-muted-foreground">
                Click on roof outline edges to mark where water drains off
                into a half-round gutter or similar. Selected edges are
                highlighted in blue with arrows.
              </p>
            </div>
          )}

          {/* Drainage edges summary */}
          {drainageEdges.length > 0 && (
            <div className="p-3 bg-muted rounded-lg">
              <p className="text-sm text-muted-foreground">
                🟦 {drainageEdges.length} drainage edge{drainageEdges.length !== 1 ? "s" : ""} defined.
                Click an edge again to remove it.
              </p>
            </div>
          )}

          {selectedOutlet && (
            <div className="p-3 border border-border rounded-lg space-y-2">
              <h4 className="text-sm font-medium">Selected Outlet</h4>
              <p className="text-xs text-muted-foreground">
                Position: ({Math.round(selectedOutlet.x)}, {Math.round(selectedOutlet.y)})
              </p>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => onDeleteOutlet(selectedOutlet.id)}
                className="w-full"
              >
                <Trash2 className="w-4 h-4 mr-1" />
                Delete Outlet
              </Button>
            </div>
          )}

          {outlets.length > 0 && (
            <div>
              <h4 className="text-sm font-medium mb-2">
                Outlets ({outlets.length})
              </h4>
              <div className="space-y-1">
                {outlets.map((outlet, idx) => (
                  <div
                    key={outlet.id}
                    className="text-xs p-2 bg-secondary rounded flex justify-between items-center"
                  >
                    <span>Outlet {idx + 1}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      onClick={() => onDeleteOutlet(outlet.id)}
                    >
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </Card>
    );
  }

  return null;
};
