from typing import Literal

from pydantic import BaseModel, Field

CandidateGeometrySource = Literal[
    "vector_polygonized_face",
    "vector_composite_region",
    "anchor_boundary_reconstruction",
    "linework_snapped_semantic_region",
    "vector_raster_refined_region",
    "coarse_semantic_search_area",
    "raster_contour_polygonisation",
    "gemini_er_box_region",
    "gemini_er_mask_region",
    "gemini_er_linework_refined_region",
    "gemini_er_segmentation_mask",
    "gemini_er_point_seeded_region",
]

PipelineProfile = Literal["vector", "raster"]
CandidateSafetyStatus = Literal["pass", "review", "blocked"]


class CandidateFeatures(BaseModel):
    contains_rooflights: bool
    rooflight_count: int
    contains_rwp_labels: bool
    rwp_label_count: int
    near_tapered_insulation_note: bool
    near_fall_arrows: bool
    overlaps_title_block: bool
    overlaps_pv_array: bool
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


class CandidateRegion(BaseModel):
    id: str
    rank: int
    polygon_pdf: list[list[float]]
    bbox_pdf: list[float]
    area_pdf_units: float
    geometry_source: CandidateGeometrySource
    geometry_confidence: float = Field(ge=0, le=1)
    eligible_for_auto_export: bool = True
    eligible_for_review_selection: bool = True
    eligible_for_final_dxf: bool = True
    review_required: bool = False
    quality_warnings: list[str] = Field(default_factory=list)
    safety_status: CandidateSafetyStatus = "review"
    safety_warnings: list[str] = Field(default_factory=list)
    raster_iou: float | None = Field(default=None, ge=0, le=1)
    features: CandidateFeatures
    scores: CandidateScores
    score: float = Field(ge=0, le=1)


class CandidateSummary(BaseModel):
    candidate_count: int
    top_candidate_id: str | None
    top_candidate_score: float | None
    roof_scope_candidate_rank: int | None
    review_candidate_ids: list[str] = Field(default_factory=list)


class CandidateDocument(BaseModel):
    document_id: str
    source_file: str
    pipeline_profile: PipelineProfile
    candidate_regions: list[CandidateRegion]
    summary: CandidateSummary
