import { Point } from "@/types/roof";

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8000";

export interface BackendCandidate {
  id: string;
  rank: number;
  polygon_pdf: number[][];
  bbox_pdf: number[];
  area_pdf_units: number;
  geometry_source: string;
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
  };
}

export interface BackendValidationResponse {
  document_id: string;
  validation: {
    selected_candidate_id: string;
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

export function exportDocument(documentId: string): Promise<BackendExportResponse> {
  return backendFetch<BackendExportResponse>(`/api/documents/${documentId}/export`, {
    method: "POST",
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
  const [candidates, validation, exportResult] = await Promise.all([
    getCandidates(upload.document_id),
    validateDocument(upload.document_id),
    exportDocument(upload.document_id),
  ]);
  const selectedId = validation.validation.selected_candidate_id || candidates.summary.top_candidate_id;
  const candidate = candidates.candidate_regions.find((item) => item.id === selectedId);
  if (!candidate) {
    throw new Error("Backend did not return the selected candidate geometry.");
  }
  return {
    documentId: upload.document_id,
    candidate,
    candidates,
    validation,
    exportResult,
  };
}

export function pointsFromNumberPairs(points: number[][]): Point[] {
  return points.map(([x, y]) => ({ x, y }));
}
