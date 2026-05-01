import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DimensionInput } from "./DimensionInput";
import { Outlet, RoofOutline } from "@/types/roof";
import { useState } from "react";

interface OutletControlsProps {
  outlets: Outlet[];
  selectedOutlet: Outlet | null;
  onDeleteOutlet: (id: string) => void;
  onUpdateOutlet: (outlet: Outlet) => void;
  outline: RoofOutline;
  onOutlineChange: (outline: RoofOutline) => void;
  outletMode: 'none' | 'add-outlets' | 'drainage-edge';
  onOutletModeChange: (mode: 'none' | 'add-outlets' | 'drainage-edge') => void;
}

export const OutletControls = ({
  outlets,
  selectedOutlet,
  onDeleteOutlet,
  onUpdateOutlet,
  outline,
  onOutlineChange,
  outletMode,
  onOutletModeChange,
}: OutletControlsProps) => {

  const toggleSegmentDrainage = (segmentIndex: number) => {
    const newSegments = [...outline.segments];
    newSegments[segmentIndex] = {
      ...newSegments[segmentIndex],
      isDrainageEdge: !newSegments[segmentIndex].isDrainageEdge,
    };
    
    onOutlineChange({
      ...outline,
      segments: newSegments,
    });
  };
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Outlets</h3>
      
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          <Button
            onClick={() => onOutletModeChange(outletMode === 'add-outlets' ? 'none' : 'add-outlets')}
            variant={outletMode === 'add-outlets' ? "default" : "outline"}
            className="flex-1"
          >
            Add Outlets
          </Button>
          <Button
            onClick={() => onOutletModeChange(outletMode === 'drainage-edge' ? 'none' : 'drainage-edge')}
            variant={outletMode === 'drainage-edge' ? "default" : "outline"}
            className="flex-1 text-xs"
          >
            Define Drainage
          </Button>
        </div>

        {outletMode === 'add-outlets' && (
          <div className="p-3 bg-red-50 border border-red-200 rounded-lg dark:bg-red-950 dark:border-red-800">
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              🔴 Click on the canvas to place outlets
            </p>
          </div>
        )}

        {outletMode === 'drainage-edge' && (
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg dark:bg-blue-950 dark:border-blue-800">
            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
              🟦 Click on roof outline segments to mark them as drainage edges
            </p>
          </div>
        )}

        {outletMode === 'none' && (
          <div className="p-3 bg-muted rounded-lg">
            <p className="text-sm text-muted-foreground">
              Select a tool above to start adding outlets or defining drainage edges
            </p>
          </div>
        )}
      </div>

      {selectedOutlet && (
        <div className="space-y-4 border-t pt-4">
          <h4 className="font-medium">Selected Outlet</h4>
          <DimensionInput
            label="Diameter"
            value={Math.round(selectedOutlet.diameter * 1000)}
            onChange={(diameter) =>
              onUpdateOutlet({ ...selectedOutlet, diameter: Number(diameter) / 1000 })
            }
            unit="mm"
            min={50}
            max={1000}
          />
          <div className="grid grid-cols-2 gap-2">
            <DimensionInput
              label="X Position"
              value={Math.round(selectedOutlet.x / 100) / 10}
              onChange={(x) =>
                onUpdateOutlet({ ...selectedOutlet, x: Number(x) * 100 })
              }
              unit="m"
            />
            <DimensionInput
              label="Y Position"
              value={Math.round(selectedOutlet.y / 100) / 10}
              onChange={(y) =>
                onUpdateOutlet({ ...selectedOutlet, y: Number(y) * 100 })
              }
              unit="m"
            />
          </div>
          <Button
            variant="destructive"
            onClick={() => onDeleteOutlet(selectedOutlet.id)}
            className="w-full"
          >
            Delete Outlet
          </Button>
        </div>
      )}

      <div className="mt-4 p-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground">
          Click on the canvas to place outlets. Click on existing outlets to select and modify them. Drag outlets to reposition.
        </p>
      </div>

      {outlets.length > 0 && (
        <div className="mt-4">
          <h4 className="font-medium mb-2">Outlet List</h4>
          <div className="space-y-2">
            {outlets.map((outlet, index) => (
              <div
                key={outlet.id}
                className="text-sm p-2 bg-secondary rounded flex justify-between items-center"
              >
                <span>Outlet {index + 1} - Ø{Math.round(outlet.diameter * 1000)}mm</span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDeleteOutlet(outlet.id)}
                >
                  ×
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  );
};