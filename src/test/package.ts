import type { PageSession } from "@/types/roi";
import { syntheticPage } from "./roi";
import { emptyDrawing, initialRoiState, roiSessionReducer } from "@/utils/roiSession";

export const packageScale = { paperSize: "A1", scaleRatio: 100 };
export const roofRectangle = [{ x: 100, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300 }, { x: 100, y: 300 }];
export const roofCutout = [{ x: 150, y: 150 }, { x: 180, y: 150 }, { x: 180, y: 180 }, { x: 150, y: 180 }];

/** An 841 px wide page at A1 1:100, so one source pixel is exactly 100 mm. */
export function packagePage(id = "page-1"): PageSession {
  const source = Object.freeze({ ...syntheticPage(id), source_width: 841, source_height: 594 });
  const state = roiSessionReducer(initialRoiState, { type: "activate", source, scale: packageScale });
  return { ...state.pages[id], drawing: { ...emptyDrawing(packageScale),
    outlines: [{ id: `outline-${id}`, page_id: id, roi_id: null, points: roofRectangle }],
    holes: [{ id: `hole-${id}`, page_id: id, roi_id: null, points: roofCutout }],
    outlets: [{ id: `outlet-${id}`, page_id: id, x: 200, y: 200, diameter: 0.12, diameter_confirmed: false }],
    drainage_edges: [{ outline_id: `outline-${id}`, edge_index: 1 }] } };
}

export function pdfFile(name: string, body = "%PDF-1.7\n% synthetic\n%%EOF\n"): File {
  return new File([body], name, { type: "application/pdf" });
}
