import type { Point } from "./roof";
import type { Box2D, PageDrawing } from "./roi";

export type OutlineBoundaryPolicy = "inner_parapet" | "roof_deck" | "outer_roof";
export interface VectorSegment { start: Point; end: Point }
export interface OutlineRequest {
  schema_version: "outline-1";
  page_id: string;
  request_id: string;
  source_image_hash: string;
  roi_revision: number;
  geometry_revision: number;
  roi: { id: string; revision: number; box_2d: Box2D };
  boundary_policy: OutlineBoundaryPolicy;
  boundary_notes: string;
  vector_segments: VectorSegment[];
}
export interface OutlineEdge {
  index: number;
  support: number;
  source: "vector" | "raster" | "unsupported";
  ambiguous: boolean;
}
export interface OutlineProposal {
  id: string;
  points: Point[];
  proposed_points: Point[];
  edges: OutlineEdge[];
  warnings: string[];
}
export interface OutlineResponse {
  schema_version: "outline-1";
  page_id: string;
  request_id: string;
  source_image_hash: string;
  roi_revision: number;
  geometry_revision: number;
  roi_id: string;
  roi_annotation_revision: number;
  boundary_policy: OutlineBoundaryPolicy;
  status: "complete" | "needs_review" | "no_outline" | "roi_too_tight";
  proposals: OutlineProposal[];
  warnings: string[];
  crop: { x: number; y: number; width: number; height: number; inference_width: number; inference_height: number };
  run: { model: string; prompt_version: string; algorithm_version: string; settings: Record<string, unknown>;
    duration_ms: number; cached: boolean; provider_attempts: number };
}
export interface OutlineUndo {
  drawing: PageDrawing;
  applied_revision: number;
}
