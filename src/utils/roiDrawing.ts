import type { DrainageEdge, Outlet, Penetration, Point } from "@/types/roof";
import type { PagePolygon, PageSession } from "@/types/roi";
import { penetrationOpenings } from "./penetrationOpenings";
import { activePageOutlets } from "./outletScope";

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

export function mmPerPixel(page: PageSession): number {
  return (PAPER_SIZES_MM[page.drawing.drawing_scale.paperSize] ?? 841)
    / Math.max(page.source.source_width, page.source.source_height) * page.drawing.drawing_scale.scaleRatio;
}

export interface DrawingObjectRef {
  id: string;
  page_id: string;
  roi_id: string | null;
  /** Keep the reviewed object identity separate from its clipped part ID. */
  annotation_id?: string;
  outline_id?: string;
}

const openingReference = (opening: PagePolygon): DrawingObjectRef => ({
  id: opening.id, page_id: opening.page_id, roi_id: opening.roi_id,
  ...(opening.annotation_id ? { annotation_id: opening.annotation_id } : {}),
  ...(opening.outline_id ? { outline_id: opening.outline_id } : {}),
});
export interface CombinedDrawing {
  roofOutlines: Point[][];
  interiorHoles: Point[][];
  outlets: Outlet[];
  penetrations: Penetration[];
  drainageEdges: DrainageEdge[];
  outlineRefs: DrawingObjectRef[];
  holeRefs: DrawingObjectRef[];
  outletRefs: DrawingObjectRef[];
  /** Real-world millimetres per combined-drawing unit (the first populated page's pixels); 0 when empty. */
  mmPerPixel: number;
}

/** `pageOffsets` (keyed by page_id) move every object on a page together, on top of the side-by-side layout. */
export function combinePageDrawings(pages: PageSession[], pageOffsets: Record<string, Point> = {}): CombinedDrawing {
  const result: CombinedDrawing = { roofOutlines: [], interiorHoles: [], outlets: [], penetrations: [], drainageEdges: [],
    outlineRefs: [], holeRefs: [], outletRefs: [], mmPerPixel: 0 };
  const populated = pages.filter((page) => page.drawing.outlines.some((outline) => outline.points.length > 0));
  const base = populated[0];
  if (!base) return result;
  result.mmPerPixel = mmPerPixel(base);
  let right = -Infinity;
  for (const page of populated) {
    const factor = mmPerPixel(page) / mmPerPixel(base);
    const sourceX = page.drawing.outlines.flatMap((outline) => outline.points.map((point) => point.x * factor));
    const offsetX = Number.isFinite(right) ? right - Math.min(...sourceX) + 40 : 0;
    const shift = pageOffsets[page.source.page_id] ?? { x: 0, y: 0 };
    const transform = (point: Point): Point => ({
      x: point.x * factor + offsetX + shift.x,
      y: point.y * factor + shift.y,
    });
    const outlineOffset = result.roofOutlines.length;
    for (const outline of page.drawing.outlines) {
      result.roofOutlines.push(outline.points.map(transform));
      result.outlineRefs.push({ id: outline.id, page_id: outline.page_id, roi_id: outline.roi_id });
    }
    for (const hole of page.drawing.holes) {
      result.interiorHoles.push(hole.points.map(transform));
      result.holeRefs.push(openingReference(hole));
    }
    for (const opening of penetrationOpenings(page)) {
      const points = opening.points.map(transform);
      result.interiorHoles.push(points);
      result.holeRefs.push(openingReference(opening));
      const left = Math.min(...points.map(point => point.x)), right = Math.max(...points.map(point => point.x));
      const top = Math.min(...points.map(point => point.y)), bottom = Math.max(...points.map(point => point.y));
      result.penetrations.push({ id: opening.id,
        ...(opening.annotation_id ? { annotation_id: opening.annotation_id } : {}),
        ...(opening.outline_id ? { outline_id: opening.outline_id } : {}),
        x: (left + right) / 2, y: (top + bottom) / 2,
        width: (right - left) * mmPerPixel(base) / 1000, height: (bottom - top) * mmPerPixel(base) / 1000,
        polygonPoints: points });
    }
    for (const outlet of activePageOutlets(page)) {
      result.outlets.push({ ...outlet, ...transform(outlet) });
      result.outletRefs.push({ id: outlet.id, page_id: outlet.page_id,
        roi_id: page.annotations.find((annotation) => annotation.id === outlet.annotation_id)?.roi_id ?? null });
    }
    result.drainageEdges.push(...editorDrainage(page).map((edge) => ({ ...edge, outlineIndex: edge.outlineIndex + outlineOffset })));
    right = Math.max(right, ...sourceX.map((value) => value + offsetX));
  }
  return result;
}

export function shiftPageOffset(previous: Record<string, Point>, pageId: string, delta: Point): Record<string, Point> {
  const current = previous[pageId] ?? { x: 0, y: 0 };
  return { ...previous, [pageId]: { x: current.x + delta.x, y: current.y + delta.y } };
}
