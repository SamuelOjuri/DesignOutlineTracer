import { DrawingScale, Outlet, Point } from "@/types/roof";
import { BackendCandidate, BackendProductionSchema } from "./client";

const PAPER_SIZES_MM: Record<string, { w: number; h: number }> = {
  A0: { w: 841, h: 1189 },
  A1: { w: 594, h: 841 },
  A2: { w: 420, h: 594 },
  A3: { w: 297, h: 420 },
  A4: { w: 210, h: 297 },
};

function pdfToCanvasPoint(
  point: number[],
  pdfCanvas: HTMLCanvasElement,
  schema: BackendProductionSchema,
): Point {
  return {
    x: Math.round((point[0] / schema.coordinate_systems.pdf.page_width) * pdfCanvas.width),
    y: Math.round((point[1] / schema.coordinate_systems.pdf.page_height) * pdfCanvas.height),
  };
}

function mmToPdfPoint(
  pointMm: number[],
  candidate: BackendCandidate,
  schema: BackendProductionSchema,
): number[] {
  const mmPerPdfUnit = schema.coordinate_systems.cad.mm_per_pdf_unit || 1;
  return [
    candidate.bbox_pdf[0] + pointMm[0] / mmPerPdfUnit,
    candidate.bbox_pdf[1] + pointMm[1] / mmPerPdfUnit,
  ];
}

export function mmPerCanvasPixel(
  pdfCanvas: HTMLCanvasElement,
  drawingScale: DrawingScale,
): number {
  const paper = PAPER_SIZES_MM[drawingScale.paperSize] || PAPER_SIZES_MM.A1;
  const canvasLong = Math.max(pdfCanvas.width, pdfCanvas.height);
  const paperLongMm = Math.max(paper.w, paper.h);
  return (paperLongMm / canvasLong) * drawingScale.scaleRatio;
}

export function backendCandidateToCanvasOutline(
  candidate: BackendCandidate,
  pdfCanvas: HTMLCanvasElement,
  schema: BackendProductionSchema,
): Point[] {
  return candidate.polygon_pdf.map((point) => pdfToCanvasPoint(point, pdfCanvas, schema));
}

export function backendRooflightsToCanvasHoles(
  candidate: BackendCandidate,
  pdfCanvas: HTMLCanvasElement,
  schema: BackendProductionSchema,
): Point[][] {
  return schema.constraints.rooflights.map((rooflight) =>
    rooflight.polygon_mm.map((point) =>
      pdfToCanvasPoint(mmToPdfPoint(point, candidate, schema), pdfCanvas, schema),
    ),
  );
}

export function backendOutletsToCanvas(
  candidate: BackendCandidate,
  pdfCanvas: HTMLCanvasElement,
  schema: BackendProductionSchema,
): Outlet[] {
  return schema.constraints.rainwater_outlets.map((outlet) => {
    const point = pdfToCanvasPoint(mmToPdfPoint(outlet.point_mm, candidate, schema), pdfCanvas, schema);
    return {
      id: outlet.id,
      x: point.x,
      y: point.y,
      diameter: 0.15,
    };
  });
}
