import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { RoiAnnotation } from "@/types/roi";
import type { Point } from "@/types/roof";
import { penetrationBoundary, validPenetrationRing } from "@/utils/penetrationGeometry";

interface PenetrationBoundaryControlsProps {
  annotation: RoiAnnotation;
  size: { width: number; height: number };
  onSave: (points: Point[]) => void;
}

export function PenetrationBoundaryControls({ annotation, size, onSave }: PenetrationBoundaryControlsProps) {
  const [error, setError] = useState<string | null>(null);
  const points = penetrationBoundary(annotation, size);
  return <div className="mt-3 space-y-2">
    <p className="text-xs text-muted-foreground">{annotation.footprint
      ? `Boundary with ${points.length} corners. Edit vertices on the drawing to follow angled or irregular edges.`
      : "Rectangular boundary. Edit vertices on the drawing to fit angled or irregular edges."}</p>
    <p className="text-xs text-muted-foreground">Drag the rotation handle on the plan to rotate the opening. Hold Shift to snap to 15° increments.</p>
    {annotation.proposed_footprint && <Button variant="outline" size="sm" className="w-full"
      onClick={() => {
        if (validPenetrationRing(annotation.proposed_footprint!, size)) {
          onSave(annotation.proposed_footprint!.map(point => ({ ...point }))); setError(null);
        } else setError("The original boundary is unavailable for this page.");
      }}>Restore proposed boundary</Button>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
