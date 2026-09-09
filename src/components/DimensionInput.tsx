import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DimensionInputProps {
  label: string;
  value: string | number;
  onChange: (value: string | number) => void;
  unit?: string;
  min?: number;
  max?: number;
}

export const DimensionInput = ({ 
  label, 
  value, 
  onChange, 
  unit = "m", 
  min = 0, 
  max = 10000 
}: DimensionInputProps) => {
  return (
    <div className="space-y-2">
      <Label className="text-sm font-medium">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          min={min}
          max={max}
          className="pr-12"
          placeholder="Enter length"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
          {unit}
        </span>
      </div>
    </div>
  );
};