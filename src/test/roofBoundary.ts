import type { Point } from "@/types/roof";

// Simplified from the reported outline: a raised top and a narrow right return.
export const steppedRoof: Point[] = [
  { x: 180, y: 40 }, { x: 300, y: 40 }, { x: 300, y: 150 },
  { x: 292, y: 150 }, { x: 292, y: 100 }, { x: 284, y: 100 },
  { x: 284, y: 220 }, { x: 160, y: 220 }, { x: 160, y: 270 },
  { x: 80, y: 270 }, { x: 80, y: 190 }, { x: 40, y: 190 },
  { x: 40, y: 160 }, { x: 100, y: 160 }, { x: 100, y: 60 }, { x: 180, y: 60 },
];

export const trimmedRoof: Point[] = [
  { x: 40, y: 160 }, { x: 100, y: 160 }, { x: 100, y: 60 },
  { x: 180, y: 60 }, { x: 180, y: 100 }, { x: 284, y: 100 },
  { x: 284, y: 220 }, { x: 160, y: 220 }, { x: 160, y: 270 },
  { x: 80, y: 270 }, { x: 80, y: 190 }, { x: 40, y: 190 },
];

export const trimmedRoofWithNotch: Point[] = [
  ...trimmedRoof.slice(0, 5),
  { x: 220, y: 100 }, { x: 220, y: 115 }, { x: 240, y: 115 }, { x: 240, y: 100 },
  ...trimmedRoof.slice(5),
];
