from typing import Literal

from pydantic import BaseModel, Field

CandidateGeometrySource = Literal[
    "vector_polygonized_face",
    "vector_composite_region",
    "anchor_boundary_reconstruction",
    "linework_snapped_semantic_region",
    "opencv_refined_vector_candidate",
    "coarse_semantic_search_area",
    "raster_contour_polygonisation",
]

PipelineProfile = Literal["vector", "raster"]

SemanticZoneType = Literal[
    "title_block",
    "legend",
    "notes",
    "pv_array",
    "existing_roof",
    "pitched_roof",
    "plant_zone",
    "non_target_roof",
    "target_scope_note",
]


class TargetScopeIntent(BaseModel):
    target_type: str = "tapered_insulation_scope"
    include_evidence: list[str] = Field(default_factory=list)
    exclude_evidence: list[str] = Field(default_factory=list)
    allow_multiple_regions: bool = False
    requires_review_if_ambiguous: bool = True


class SemanticZone(BaseModel):
    id: str
    type: SemanticZoneType
    page_number: int
    bbox_pdf: list[float]
    confidence: float = Field(ge=0, le=1)
    source: str
    reason: str
    excluded: bool = True


class CandidateBoundaryMetrics(BaseModel):
    boundary_supported_ratio: float = Field(default=0.0, ge=0, le=1)
    synthetic_boundary_ratio: float = Field(default=0.0, ge=0, le=1)
    search_boundary_touch_ratio: float = Field(default=0.0, ge=0, le=1)
    bridge_count: int = Field(default=0, ge=0)
    included_positive_anchor_ratio: float = Field(default=0.0, ge=0, le=1)
    excluded_anchor_overlap_ratio: float = Field(default=0.0, ge=0, le=1)
    internal_constraint_coverage: float = Field(default=0.0, ge=0, le=1)
    overunion_risk: float = Field(default=0.0, ge=0, le=1)
    scope_fragment_risk: float = Field(default=0.0, ge=0, le=1)
    linework_closure_confidence: float = Field(default=0.0, ge=0, le=1)


class OpenCvRefinementMetrics(BaseModel):
    edge_snap_ratio: float = Field(default=0.0, ge=0, le=1)
    boundary_support_ratio: float = Field(default=0.0, ge=0, le=1)
    excluded_region_removed_area_ratio: float = Field(default=0.0, ge=0, le=1)
    semantic_anchor_retention: float = Field(default=0.0, ge=0, le=1)
    area_change_ratio: float = Field(default=0.0, ge=0, le=1)


class RefinedCandidateResult(BaseModel):
    accepted: bool
    source_candidate_id: str
    geometry_source: str = "opencv_refined_vector_candidate"
    polygon_pdf: list[list[float]] = Field(default_factory=list)
    metrics: OpenCvRefinementMetrics = Field(default_factory=OpenCvRefinementMetrics)
    warnings: list[str] = Field(default_factory=list)


class CandidateFeatures(BaseModel):
    contains_rooflights: bool
    rooflight_count: int
    contains_rwp_labels: bool
    rwp_label_count: int
    near_tapered_insulation_note: bool
    near_fall_arrows: bool
    overlaps_title_block: bool
    overlaps_pv_array: bool
    overlaps_exclusion_zone: bool = False
    positive_anchor_count: int = 0
    positive_anchor_coverage: float = Field(default=0.0, ge=0, le=1)
    geometry_valid: bool
    plausible_area: bool


class CandidateScores(BaseModel):
    geometric_validity: float = Field(ge=0, le=1)
    agreement_with_vector_linework: float = Field(ge=0, le=1)
    contains_expected_rooflights: float = Field(ge=0, le=1)
    contains_expected_rwp_points: float = Field(ge=0, le=1)
    proximity_to_tapered_insulation_notes: float = Field(ge=0, le=1)
    excludes_title_block_legend_pv: float = Field(ge=0, le=1)
    plausible_area_and_dimensions: float = Field(ge=0, le=1)
    boundary_evidence_quality: float = Field(default=0.0, ge=0, le=1)
    semantic_scope_alignment: float = Field(default=0.0, ge=0, le=1)
    excludes_detected_exclusions: float = Field(default=1.0, ge=0, le=1)


class CandidateRegion(BaseModel):
    id: str
    rank: int
    polygon_pdf: list[list[float]]
    bbox_pdf: list[float]
    area_pdf_units: float
    geometry_source: CandidateGeometrySource
    geometry_confidence: float = Field(ge=0, le=1)
    eligible_for_auto_export: bool = True
    review_required: bool = False
    quality_warnings: list[str] = Field(default_factory=list)
    source_candidate_id: str | None = None
    source_geometry_source: CandidateGeometrySource | None = None
    opencv_refinement: OpenCvRefinementMetrics | None = None
    features: CandidateFeatures
    scores: CandidateScores
    boundary_metrics: CandidateBoundaryMetrics = Field(default_factory=CandidateBoundaryMetrics)
    score: float = Field(ge=0, le=1)


class CandidateSummary(BaseModel):
    candidate_count: int
    top_candidate_id: str | None
    top_candidate_score: float | None
    roof_scope_candidate_rank: int | None


class CandidateDocument(BaseModel):
    document_id: str
    source_file: str
    pipeline_profile: PipelineProfile
    candidate_regions: list[CandidateRegion]
    summary: CandidateSummary
    target_scope_intent: TargetScopeIntent = Field(default_factory=TargetScopeIntent)
    semantic_zones: list[SemanticZone] = Field(default_factory=list)
