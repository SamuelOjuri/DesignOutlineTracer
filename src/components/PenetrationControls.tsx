import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { DimensionInput } from "./DimensionInput";
import { Penetration } from "@/types/roof";

interface PenetrationControlsProps {
  penetrations: Penetration[];
  selectedPenetration: Penetration | null;
  onDeletePenetration: (id: string) => void;
  onUpdatePenetration: (penetration: Penetration) => void;
}

export const PenetrationControls = ({
  penetrations,
  selectedPenetration,
  onDeletePenetration,
  onUpdatePenetration,
}: PenetrationControlsProps) => {
  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold mb-4">Penetrations</h3>
      
      <div className="mb-4 p-3 bg-accent/10 rounded-lg">
        <p className="text-sm font-medium text-accent-foreground">
          🟡 Click on the canvas to place penetrations
        </p>
      </div>

      {selectedPenetration && (
        <div className="space-y-4 border-t pt-4">
          <h4 className="font-medium">Selected Penetration</h4>
          <div className="grid grid-cols-2 gap-2">
            <DimensionInput
              label="Width"
              value={Math.round(selectedPenetration.width * 1000)}
              onChange={(width) =>
                onUpdatePenetration({ ...selectedPenetration, width: Number(width) / 1000 })
              }
              unit="mm"
              min={50}
              max={5000}
            />
            <DimensionInput
              label="Height"
              value={Math.round(selectedPenetration.height * 1000)}
              onChange={(height) =>
                onUpdatePenetration({ ...selectedPenetration, height: Number(height) / 1000 })
              }
              unit="mm"
              min={50}
              max={5000}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <DimensionInput
              label="X Position"
              value={Math.round(selectedPenetration.x / 100) / 10}
              onChange={(x) =>
                onUpdatePenetration({ ...selectedPenetration, x: Number(x) * 100 })
              }
              unit="m"
            />
            <DimensionInput
              label="Y Position"
              value={Math.round(selectedPenetration.y / 100) / 10}
              onChange={(y) =>
                onUpdatePenetration({ ...selectedPenetration, y: Number(y) * 100 })
              }
              unit="m"
            />
          </div>
          <Button
            variant="destructive"
            onClick={() => onDeletePenetration(selectedPenetration.id)}
            className="w-full"
          >
            Delete Penetration
          </Button>
        </div>
      )}

      <div className="mt-4 p-3 bg-muted rounded-lg">
        <p className="text-sm text-muted-foreground">
          Click on the canvas to place penetrations. Click on existing penetrations to select and modify them. Drag to reposition.
        </p>
      </div>

      {penetrations.length > 0 && (
        <div className="mt-4">
          <h4 className="font-medium mb-2">Penetration List</h4>
          <div className="space-y-2">
            {penetrations.map((penetration, index) => (
              <div
                key={penetration.id}
                className="text-sm p-2 bg-secondary rounded flex justify-between items-center"
              >
                <span>
                  Penetration {index + 1} - {Math.round(penetration.width * 1000)}×{Math.round(penetration.height * 1000)}mm
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onDeletePenetration(penetration.id)}
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