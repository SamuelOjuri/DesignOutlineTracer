import type { DrawingScale, Outlet, Point } from "./roof";

export type Box2D = readonly [ymin: number, xmin: number, ymax: number, xmax: number];
export type AnnotationKind = "roof_roi" | "penetration" | "rainwater_outlet";
export type ReviewStatus = "suggested" | "accepted" | "rejected";
export type AnnotationValidity = "current" | "needs_review";

export interface PageContext {
  readonly document_id: string;
  readonly file_name: string;
  readonly page_id: string;
  readonly page_index: number;
  readonly source_image_hash: string;
  readonly source_width: number;
  readonly source_height: number;
  readonly render_scale: number;
  readonly render_rotation: number;
  readonly render_version: string;
  readonly pdf_view_box: readonly number[];
}

export interface RenderedPdfPage extends PageContext {
  readonly source_blob: Blob;
}

export interface AnnotationEdit {
  revision: number;
  action: "edit" | "review" | "invalidate" | "undo";
}

export interface RoiAnnotation {
  id: string;
  page_id: string;
  kind: AnnotationKind;
  label: string;
  subtype?: "rooflight" | "vent" | "flue" | "access_hatch" | "internal_outlet" | "parapet_outlet" | "scupper";
  box_2d: Box2D;
  proposed_box_2d: Box2D;
  roi_id: string | null;
  origin: "gemini" | "manual";
  review_status: ReviewStatus;
  validity: AnnotationValidity;
  revision: number;
  edits: AnnotationEdit[];
  evidence?: string;
  warnings: string[];
  editor_object_id?: string;
}

export interface DetectionRequest {
  page_id: string;
  request_id: string;
  task: AnnotationKind;
  source_image_hash: string;
  roi_revision: number | null;
  geometry_revision: number;
}

export interface DetectionRun extends DetectionRequest {
  model: string;
  prompt_version: string;
  schema_version: string;
  settings: Readonly<Record<string, unknown>>;
  started_at: string;
  duration_ms: number;
  status: "complete" | "no_detections" | "partial";
  warnings: string[];
}

export interface PagePolygon {
  id: string;
  page_id: string;
  roi_id: string | null;
  points: Point[];
}

export interface PageOutlet extends Outlet {
  page_id: string;
  annotation_id?: string;
}

export interface PageDrawing {
  outlines: PagePolygon[];
  holes: PagePolygon[];
  outlets: PageOutlet[];
  drainage_edges: { outline_id: string; edge_index: number }[];
  drawing_scale: DrawingScale;
}

export interface PageSession {
  source: RenderedPdfPage;
  annotations: RoiAnnotation[];
  roi_revision: number;
  geometry_revision: number;
  revision: number;
  pending: Partial<Record<AnnotationKind, DetectionRequest>>;
  used_request_ids: string[];
  runs: DetectionRun[];
  history: { id: string; before: RoiAnnotation | null; roi_revision: number; geometry_revision: number }[];
  drawing: PageDrawing;
}

export interface RoiSessionState {
  active_page_id: string | null;
  pages: Record<string, PageSession>;
}