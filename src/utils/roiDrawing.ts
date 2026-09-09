import type { DrainageEdge, Outlet, Point } from "@/types/roof";
import type { PagePolygon, PageSession } from "@/types/roi";

export function reconcilePolygons(previous: PagePolygon[], points: Point[][], pageId: string, editedIndex?: number): PagePolygon[] {
  const used = new Set<string>();
  return points.map((polygon, index) => {
    const existing = editedIndex === index ? previous[index] : previous.find((record) => !used.has(record.id)
      && JSON.stringify(record.points) === JSON.stringify(polygon));
    if (existing) used.add(existing.id);
    return { id: existing?.id ?? crypto.randomUUID(), page_id: pageId, roi_id: existing?.roi_id ?? null,
      points: polygon.map((point) => ({ ...point })) };
  });
}

export function editorDrainage(page: PageSession): DrainageEdge[] {
  return page.drawing.drainage_edges.flatMap((edge) => {
    const index = page.drawing.outlines.findIndex((outline) => outline.id === edge.outline_id);
    return index < 0 ? [] : [{ outlineIndex: index, edgeIndex: edge.edge_index }];
  });
}

const PAPER_SIZES_MM: Record<string, number> = { A0: 1189, A1: 841, A2: 594, A3: 420, A4: 297 };

function mmPerPixel(page: PageSession): number {
  return (PAPER_SIZES_MM[page.drawing.drawing_scale.paperSize] ?? 841)
    / Math.max(page.source.source_width, page.source.source_height) * page.drawing.drawing_scale.scaleRatio;
}

export interface DrawingObjectRef { id: string; page_id: string; roi_id: string | null }
export interface CombinedDrawing {
  roofOutlines: Point[][];
  interiorHoles: Point[][];
  outlets: Outlet[];
  drainageEdges: DrainageEdge[];
  outlineRefs: DrawingObjectRef[];
  holeRefs: DrawingObjectRef[];
  outletRefs: DrawingObjectRef[];
}

export function combinePageDrawings(pages: PageSession[], offsets: Record<string, Point> = {}): CombinedDrawing {
  const result: CombinedDrawing = { roofOutlines: [], interiorHoles: [], outlets: [], drainageEdges: [],
    outlineRefs: [], holeRefs: [], outletRefs: [] };
  const populated = pages.filter((page) => page.drawing.outlines.some((outline) => outline.points.length > 0));
  const base = populated[0];
  if (!base) return result;
  let right = -Infinity;
  for (const page of populated) {
    const factor = mmPerPixel(page) / mmPerPixel(base);
    const sourceX = page.drawing.outlines.flatMap((outline) => outline.points.map((point) => point.x * factor));
    const offsetX = Number.isFinite(right) ? right - Math.min(...sourceX) + 40 : 0;
    const transform = (point: Point, id: string): Point => ({
      x: point.x * factor + offsetX + (offsets[id]?.x ?? 0),
      y: point.y * factor + (offsets[id]?.y ?? 0),
    });
    const outlineOffset = result.roofOutlines.length;
    for (const outline of page.drawing.outlines) {
      result.roofOutlines.push(outline.points.map((point) => transform(point, outline.id)));
      result.outlineRefs.push({ id: outline.id, page_id: outline.page_id, roi_id: outline.roi_id });
    }
    for (const hole of page.drawing.holes) {
      result.interiorHoles.push(hole.points.map((point) => transform(point, hole.id)));
      result.holeRefs.push({ id: hole.id, page_id: hole.page_id, roi_id: hole.roi_id });
    }
    for (const outlet of page.drawing.outlets) {
      result.outlets.push({ id: outlet.id, diameter: outlet.diameter, ...transform(outlet, outlet.id) });
      result.outletRefs.push({ id: outlet.id, page_id: outlet.page_id,
        roi_id: page.annotations.find((annotation) => annotation.id === outlet.annotation_id)?.roi_id ?? null });
    }
    result.drainageEdges.push(...editorDrainage(page).map((edge) => ({ ...edge, outlineIndex: edge.outlineIndex + outlineOffset })));
    right = Math.max(right, ...sourceX.map((value) => value + offsetX));
  }
  return result;
}

export function shiftedOffsets(previous: Record<string, Point>, refs: DrawingObjectRef[], before: Point[], after: Point[]): Record<string, Point> {
  const next = { ...previous };
  refs.forEach((reference, index) => {
    if (!before[index] || !after[index]) return;
    next[reference.id] = { x: (previous[reference.id]?.x ?? 0) + after[index].x - before[index].x,
      y: (previous[reference.id]?.y ?? 0) + after[index].y - before[index].y };
  });
  return next;
}