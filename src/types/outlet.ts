import type { Point } from "./roof";
import type { Box2D, RoiAnnotation } from "./roi";

export const outletSubtypes = ["internal_outlet", "parapet_outlet", "scupper"] as const;
export type OutletSubtype = typeof outletSubtypes[number];

/** Exact usable insulation, in immutable source-page pixels. */
export interface OutletScope {
  roi_id: string;
  outline_id: string;
  polygons: { outer: Point[]; holes: Point[][] }[];
  /** Preserve exclusions that touch the perimeter and therefore become exterior notches. */
  excluded_openings?: Point[][];
}

export interface OutletRequest {
  contract_version: "outlet-1";
  page_id: string;
  request_id: string;
  source_image_hash: string;
  scope_signature: string;
  roi_revision: number;
  geometry_revision: number;
  accepted_rois: { id: string; revision: number; box_2d: Box2D }[];
  scopes: OutletScope[];
}

export interface OutletProposal extends RoiAnnotation {
  kind: "rainwater_outlet";
  subtype: OutletSubtype;
  roi_id: string;
  outline_id: string;
  anchor: Point;
  proposed_anchor: Point;
}

export interface OutletResponse {
  contract_version: "outlet-1";
  page_id: string;
  request_id: string;
  source_image_hash: string;
  scope_signature: string;
  status: "complete" | "partial" | "no_detections";
  annotations: OutletProposal[];
  warnings: string[];
  model: string;
  prompt_version: string;
  run?: Record<string, unknown>;
}
