import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DimensionInput } from "./DimensionInput";
import { RoofOutline, RoofSegment } from "@/types/roof";
import { useState } from "react";
import { 
  ArrowUp, 
  ArrowDown, 
  ArrowLeft, 
  ArrowRight,
  ArrowUpLeft,
  ArrowUpRight,
  ArrowDownLeft,
  ArrowDownRight
} from "lucide-react";

interface OutlineControlsProps {
  outline: RoofOutline;
  onOutlineChange: (outline: RoofOutline) => void;
}

export const OutlineControls = ({ outline, onOutlineChange }: OutlineControlsProps) => {
  const [segmentLength, setSegmentLength] = useState(""); // Empty default to avoid typing over 0

  const addSegment = (direction: 'up' | 'down' | 'left' | 'right' | 'up-right' | 'up-left' | 'down-right' | 'down-left') => {
    const lengthInMeters = segmentLength === "" ? 1 : Number(segmentLength);
    const newSegment: RoofSegment = {
      direction,
      length: lengthInMeters * 1000, // Convert meters to mm for storage
    };

    const newSegments = [...outline.segments, newSegment];
    
    // Calculate new current point
    let newCurrentPoint = { ...outline.currentPoint };
    const diagonalMultiplier = Math.sqrt(2) / 2; // For 45-degree angles
    
    switch (direction) {
      case 'right':
        newCurrentPoint.x += lengthInMeters * 1000;
        break;
      case 'left':
        newCurrentPoint.x -= lengthInMeters * 1000;
        break;
      case 'up':
        newCurrentPoint.y -= lengthInMeters * 1000;
        break;
      case 'down':
        newCurrentPoint.y += lengthInMeters * 1000;
        break;
      case 'up-right':
        newCurrentPoint.x += lengthInMeters * 1000 * diagonalMultiplier;
        newCurrentPoint.y -= lengthInMeters * 1000 * diagonalMultiplier;
        break;
      case 'up-left':
        newCurrentPoint.x -= lengthInMeters * 1000 * diagonalMultiplier;
        newCurrentPoint.y -= lengthInMeters * 1000 * diagonalMultiplier;
        break;
      case 'down-right':
        newCurrentPoint.x += lengthInMeters * 1000 * diagonalMultiplier;
        newCurrentPoint.y += lengthInMeters * 1000 * diagonalMultiplier;
        break;
      case 'down-left':
        newCurrentPoint.x -= lengthInMeters * 1000 * diagonalMultiplier;
        newCurrentPoint.y += lengthInMeters * 1000 * diagonalMultiplier;
        break;
    }

    onOutlineChange({
      ...outline,
      segments: newSegments,
      currentPoint: newCurrentPoint,
    });
  };

  const removeLastSegment = () => {
    if (outline.segments.length === 0) return;

    const newSegments = outline.segments.slice(0, -1);
    
    // Recalculate current point
    let newCurrentPoint = { ...outline.startPoint };
    const diagonalMultiplier = Math.sqrt(2) / 2;
    
    newSegments.forEach(segment => {
      if (segment.direction === 'custom' && segment.customAngle !== undefined) {
        // Handle custom angle segments
        const angleRad = (segment.customAngle * Math.PI) / 180;
        const deltaX = segment.length * Math.cos(angleRad);
        const deltaY = segment.length * Math.sin(angleRad);
        newCurrentPoint.x += deltaX;
        newCurrentPoint.y += deltaY;
      } else {
        // Handle predefined direction segments
        switch (segment.direction) {
          case 'right':
            newCurrentPoint.x += segment.length;
            break;
          case 'left':
            newCurrentPoint.x -= segment.length;
            break;
          case 'up':
            newCurrentPoint.y -= segment.length;
            break;
          case 'down':
            newCurrentPoint.y += segment.length;
            break;
          case 'up-right':
            newCurrentPoint.x += segment.length * diagonalMultiplier;
            newCurrentPoint.y -= segment.length * diagonalMultiplier;
            break;
          case 'up-left':
            newCurrentPoint.x -= segment.length * diagonalMultiplier;
            newCurrentPoint.y -= segment.length * diagonalMultiplier;
            break;
          case 'down-right':
            newCurrentPoint.x += segment.length * diagonalMultiplier;
            newCurrentPoint.y += segment.length * diagonalMultiplier;
            break;
          case 'down-left':
            newCurrentPoint.x -= segment.length * diagonalMultiplier;
            newCurrentPoint.y += segment.length * diagonalMultiplier;
            break;
        }
      }
    });

    onOutlineChange({
      ...outline,
      segments: newSegments,
      currentPoint: newCurrentPoint,
    });
  };

  const resetOutline = () => {
    onOutlineChange({
      segments: [],
      startPoint: { x: 100, y: 100 },
      currentPoint: { x: 100, y: 100 },
    });
  };

  const isClosedShape = () => {
    return outline.segments.length >= 3 && 
           Math.abs(outline.currentPoint.x - outline.startPoint.x) < 10 &&
           Math.abs(outline.currentPoint.y - outline.startPoint.y) < 10;
  };

  const canCloseLoop = () => {
    return outline.segments.length >= 2 && !isClosedShape();
  };

  const closeLoop = () => {
    if (!canCloseLoop()) return;

    // Calculate the difference between current point and start point (in mm)
    const deltaX = outline.startPoint.x - outline.currentPoint.x;
    const deltaY = outline.startPoint.y - outline.currentPoint.y;
    
    console.log('Close Loop Debug:');
    console.log('Start point:', outline.startPoint);
    console.log('Current point:', outline.currentPoint);
    console.log('Delta X:', deltaX, 'Delta Y:', deltaY);
    
    if (Math.abs(deltaX) < 10 && Math.abs(deltaY) < 10) return; // Already close enough
    
    // Calculate the direct distance and angle to the start point
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    // Fix the angle calculation - in screen coordinates Y increases downward
    const angle = Math.atan2(deltaY, deltaX) * 180 / Math.PI; // Remove the -deltaY
    const normalizedAngle = (angle + 360) % 360; // Ensure positive angle
    
    console.log('Distance to start:', distance);
    console.log('Raw angle:', angle);
    console.log('Normalized angle:', normalizedAngle, 'degrees');
    
    // Test: let's see what direction this should actually point
    console.log('Expected movement: deltaX =', deltaX, 'deltaY =', deltaY);
    if (deltaX > 0) console.log('Should move RIGHT');
    if (deltaX < 0) console.log('Should move LEFT');
    if (deltaY > 0) console.log('Should move DOWN');
    if (deltaY < 0) console.log('Should move UP');

    const newSegment: RoofSegment = {
      direction: 'custom',
      length: distance,
      customAngle: normalizedAngle,
    };

    console.log('New custom segment to add:', newSegment);

    const newSegments = [...outline.segments, newSegment];
    
    onOutlineChange({
      ...outline,
      segments: newSegments,
      currentPoint: { ...outline.startPoint },
    });
  };

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Roof Outline Builder</h3>
      
      <div className="space-y-4">
        <DimensionInput
          label="Segment Length"
          value={segmentLength}
          onChange={(value) => setSegmentLength(value as string)}
          unit="m"
          min={0.1}
          max={100}
        />

        <div className="grid grid-cols-5 gap-3">
          <Button
            onClick={() => addSegment('up-left')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowUpLeft className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => addSegment('up')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => addSegment('up-right')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowUpRight className="h-4 w-4" />
          </Button>
          <div></div>
          <div></div>
          
          <Button
            onClick={() => addSegment('left')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center justify-center text-xs font-medium text-muted-foreground bg-muted/30 rounded-md border-2 border-dashed border-muted-foreground/20">
            Current
          </div>
          <Button
            onClick={() => addSegment('right')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
          <div></div>
          <div></div>
          
          <Button
            onClick={() => addSegment('down-left')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowDownLeft className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => addSegment('down')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            onClick={() => addSegment('down-right')}
            variant="outline"
            size="sm"
            className="aspect-square hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            <ArrowDownRight className="h-4 w-4" />
          </Button>
          <div></div>
          <div></div>
        </div>

        <div className="flex gap-2">
          <Button
            onClick={removeLastSegment}
            variant="destructive"
            disabled={outline.segments.length === 0}
            className="flex-1"
          >
            Undo Last
          </Button>
          <Button
            onClick={resetOutline}
            variant="outline"
            className="flex-1"
          >
            Reset
          </Button>
        </div>

        {canCloseLoop() && (
          <Button
            onClick={closeLoop}
            variant="outline"
            className="w-full"
          >
            Close Loop
          </Button>
        )}

        {isClosedShape() && (
          <div className="p-3 bg-accent text-accent-foreground rounded-lg">
            ✓ Shape is closed and ready!
          </div>
        )}
      </div>

      <div className="mt-4 p-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground">
          Set the segment length and use the arrow buttons to build your roof outline step by step. Start from any point and create the perimeter.
        </p>
      </div>

      {outline.segments.length > 0 && (
        <div className="mt-4">
          <h4 className="font-medium mb-2">Segments ({outline.segments.length})</h4>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {outline.segments.map((segment, index) => (
              <div
                key={index}
                className="text-sm p-2 bg-secondary rounded flex justify-between items-center"
              >
                <span>
                  {index + 1}. {
                    segment.direction === 'custom' && segment.customAngle !== undefined
                      ? `Custom ${segment.customAngle.toFixed(1)}°`
                      : segment.direction.replace('up-left', '↖').replace('up-right', '↗').replace('down-left', '↙').replace('down-right', '↘').replace('up', '↑').replace('down', '↓').replace('left', '←').replace('right', '→')
                  } - {(segment.length / 1000).toFixed(2)}m
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};