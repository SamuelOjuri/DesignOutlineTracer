import { Point } from "@/types/roof";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

export interface BackendCandidate {
  id: string;
  rank: number;
  polygon_pdf: number[][];
  bbox_pdf: number[];
  area_pdf_units: number;
  geometry_source: string;
  geometry_confidence: number;
  eligible_for_auto_export?: boolean;
  review_required?: boolean;
  quality_warnings?: string[];
  safety_status?: "pass" | "review" | "blocked";
  safety_warnings?: string[];
  score: number;
  features: {
    rooflight_count: number;
    rwp_label_count: number;
    contains_rooflights: boolean;
    contains_rwp_labels: boolean;
    overlaps_title_block: boolean;
    overlaps_pv_array: boolean;
  };
}

export interface BackendCandidateDocument {
  document_id: string;
  source_file: string;
  candidate_regions: BackendCandidate[];
  summary: {
    candidate_count: number;
    top_candidate_id: string | null;
    top_candidate_score: number | null;
    roof_scope_candidate_rank: number | null;
    review_candidate_ids?: string[];
  };
}

export interface BackendValidationResponse {
  document_id: string;
  validation: {
    selected_candidate_id: string;
    selected_review_candidate_id?: string | null;
    selected_auto_export_candidate_id?: string | null;
    confidence: number;
    review_required: boolean;
    reason: string;
    provider: string;
    model: string;
  };
}

export interface BackendProductionSchema {
  document: {
    document_id: string;
    source_file: string;
    source_type: string;
    drawing_type: string;
  };
  coordinate_systems: {
    pdf: {
      units: string;
      page_width: number;
      page_height: number;
    };
    cad: {
      units: string;
      scale: string;
      calibration_source: string;
      mm_per_pdf_unit: number;
      calibration_confidence?: number;
      requires_user_confirmation?: boolean;
    };
  };
  target_area: {
    outer_polygon_mm: number[][];
    area_m2_estimated: number;
    confidence: number;
    review_required: boolean;
  };
  constraints: {
    rainwater_outlets: Array<{
      id: string;
      point_mm: number[];
      confidence: number;
    }>;
    rooflights: Array<{
      id: string;
      polygon_mm: number[][];
      confidence: number;
    }>;
    excluded_regions?: Array<{
      type: string;
      reason: string;
    }>;
  };
  quality_checks: {
    human_review_status: string;
    polygon_closed: boolean;
    self_intersections: boolean;
  };
}

export interface BackendExportResponse {
  document_id: string;
  production_schema: BackendProductionSchema;
  exports: Record<string, string | null>;
}

export interface BackendRasterExtractionResponse {
  document_id: string;
  pipeline: "raster_first";
  human_review_status: "required";
  production_schema: BackendProductionSchema;
  warnings: Array<{ code: string; message: string }>;
}

export interface AutomatedExtractionResult {
  documentId: string;
  candidate: BackendCandidate;
  validatedCandidate: BackendCandidate;
  candidates: BackendCandidateDocument;
  validation: BackendValidationResponse;
  exportResult: BackendExportResponse;
}

async function backendFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${BACKEND_URL}${path}`, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend ${response.status}: ${text}`);
  }
  return response.json() as Promise<T>;
}

export async function checkBackendHealth(): Promise<boolean> {
  try {
    await backendFetch<{ status: string }>("/health");
    return true;
  } catch {
    return false;
  }
}

export async function uploadDocument(file: File): Promise<{ document_id: string }> {
  const formData = new FormData();
  formData.append("file", file);
  return backendFetch<{ document_id: string }>("/api/documents", {
    method: "POST",
    body: formData,
  });
}

export function getCandidates(documentId: string): Promise<BackendCandidateDocument> {
  return backendFetch<BackendCandidateDocument>(`/api/documents/${documentId}/candidates`);
}

export function validateDocument(documentId: string): Promise<BackendValidationResponse> {
  return backendFetch<BackendValidationResponse>(`/api/documents/${documentId}/validate`, {
    method: "POST",
  });
}

export function exportDocument(
  documentId: string,
  formats?: string[],
): Promise<BackendExportResponse> {
  return backendFetch<BackendExportResponse>(`/api/documents/${documentId}/export`, {
    method: "POST",
    ...(formats
      ? {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ formats }),
        }
      : {}),
  });
}

export function extractRasterDocument(documentId: string): Promise<BackendRasterExtractionResponse> {
  return backendFetch<BackendRasterExtractionResponse>(`/api/documents/${documentId}/extract`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force_pipeline: "raster_first" }),
  });
}

export function approveDocument(schema: BackendProductionSchema): Promise<{
  document_id: string;
  approval_status: string;
  approved_at: string;
  export_unlocked: boolean;
}> {
  return backendFetch(`/api/documents/${schema.document.document_id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      approved_by: "frontend_user",
      source: "frontend_review",
      target_area: {
        outer_polygon_mm: schema.target_area.outer_polygon_mm,
        holes: [],
      },
      constraints: schema.constraints,
      notes: "User reviewed raster-derived outline in New Build flow.",
    }),
  });
}

export async function runAutomatedExtraction(file: File): Promise<AutomatedExtractionResult> {
  const upload = await uploadDocument(file);
  const [candidates, validation] = await Promise.all([
    getCandidates(upload.document_id),
    validateDocument(upload.document_id),
  ]);
  const exportResult = await exportDocument(upload.document_id, [
    "svg",
    "geojson",
    "mask_png",
    "metadata_json",
  ]);
  const selectedId =
    validation.validation.selected_review_candidate_id ||
    validation.validation.selected_candidate_id ||
    candidates.summary.top_candidate_id;
  const validatedCandidate = candidates.candidate_regions.find((item) => item.id === selectedId);
  if (!validatedCandidate) {
    throw new Error("Backend did not return the selected candidate geometry.");
  }
  const candidate = selectDisplayCandidate(candidates, validation) ?? validatedCandidate;
  return {
    documentId: upload.document_id,
    candidate,
    validatedCandidate,
    candidates,
    validation,
    exportResult,
  };
}

export function selectDisplayCandidate(
  candidates: BackendCandidateDocument,
  validation: BackendValidationResponse,
): BackendCandidate | null {
  const selectedId =
    validation.validation.selected_review_candidate_id ||
    validation.validation.selected_candidate_id ||
    candidates.summary.top_candidate_id;
  const selectedCandidate = candidates.candidate_regions.find((item) => item.id === selectedId) ?? null;
  if (!validation.validation.review_required) {
    return selectedCandidate;
  }

  const summaryReviewCandidate = candidates.summary.review_candidate_ids
    ?.map((id) => candidates.candidate_regions.find((candidate) => candidate.id === id))
    .find((candidate): candidate is BackendCandidate => Boolean(candidate));
  if (summaryReviewCandidate) {
    return summaryReviewCandidate;
  }

  const reviewCandidates = candidates.candidate_regions
    .filter(isReviewVisibleCandidate)
    .sort((left, right) => reviewCandidatePriority(right) - reviewCandidatePriority(left));

  return reviewCandidates[0] ?? selectedCandidate;
}

function isReviewVisibleCandidate(candidate: BackendCandidate): boolean {
  if (candidate.geometry_source !== "anchor_boundary_reconstruction") return false;
  return Boolean(
    candidate.features.rwp_label_count >= 2 ||
      candidate.quality_warnings?.includes("synthetic_gap_bridges_used") ||
      candidate.quality_warnings?.includes("candidate_area_outlier") ||
      candidate.geometry_confidence >= 0.72,
  );
}

function reviewCandidatePriority(candidate: BackendCandidate): number {
  let priority = 0;
  priority += candidate.features.rwp_label_count * 100;
  priority += candidate.quality_warnings?.includes("candidate_area_outlier") ? 50 : 0;
  priority += candidate.quality_warnings?.includes("synthetic_gap_bridges_used") ? 40 : 0;
  priority += candidate.safety_status === "blocked" ? 10 : 0;
  priority += Math.min(candidate.area_pdf_units / 10_000, 25);
  return priority;
}

export function pointsFromNumberPairs(points: number[][]): Point[] {
  return points.map(([x, y]) => ({ x, y }));
}
