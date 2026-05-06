from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.production import ProductionSchema

RasterTextClass = Literal[
    "rwp_label",
    "scale_text",
    "fall_path_note",
    "title_block_text",
    "roof_build_up_note",
    "rooflight_label",
    "drawing_number",
    "revision",
    "status",
    "legend_text",
    "general_note",
    "dimension_text",
    "other",
]

RasterPrimitiveType = Literal[
    "line",
    "contour",
    "rectangle",
    "component",
    "fall_arrow",
    "scale_bar",
]
SegmentationProviderName = Literal[
    "noop",
    "mock",
    "self_hosted_falcon",
    "future_api",
    "gemini_er",
]


class RasterSheetRegion(BaseModel):
    type: str
    bbox_px: list[int]
    source: str = "raster_viewport_detection"
    confidence: float = Field(ge=0, le=1)


class RasterRenderMetadata(BaseModel):
    source: str = "pymupdf"
    page_index: int
    preview_dpi: int
    render_dpi: int
    width_px: int
    height_px: int
    render_scope: str
    max_pixels_guard_applied: bool


class RasterRenderResult(BaseModel):
    render: RasterRenderMetadata
    preview_path: str
    render_full_path: str
    render_viewport_path: str
    viewport_bbox_px: list[int]


class RasterTextBlock(BaseModel):
    id: str
    text: str
    bbox_px: list[int]
    bbox_1000: list[int]
    bbox_source: str
    text_confidence: float = Field(ge=0, le=1)
    bbox_confidence: float = Field(ge=0, le=1)
    text_class: RasterTextClass = Field(alias="class")
    class_source: str
    class_confidence: float = Field(ge=0, le=1)
    tile_id: str | None = None


class OcrHints(BaseModel):
    document_id: str
    source_file: str
    page_index: int = 0
    render_dpi: int
    prompt_version: str = "raster-ocr-v1"


class OcrAudit(BaseModel):
    provider: str
    model: str
    tile_count: int
    cache_hits: int
    cache_misses: int
    live_calls: int
    budget_exceeded: bool


class ImageDerivedPrimitive(BaseModel):
    id: str
    type: RasterPrimitiveType
    source: str = "image_derived"
    method: str
    confidence: float = Field(ge=0, le=1)
    start_px: list[int] | None = None
    end_px: list[int] | None = None
    bbox_px: list[int] | None = None
    polygon_px: list[list[int]] | None = None


class SegmentationHints(BaseModel):
    document_id: str
    source_file: str
    crop_bbox_px: list[int] | None = None
    debug_dir_path: str | None = None


class SegmentationCandidate(BaseModel):
    id: str
    type: str = "closed_polygon"
    source: str
    provider: SegmentationProviderName
    prompt: str
    label: str | None = None
    point_norm: list[int] | None = None
    point_px: list[float] | None = None
    bbox_px: list[float]
    polygon_px: list[list[float]]
    mask_area_px: float
    geometry_confidence: float = Field(ge=0, le=1)
    semantic_confidence: float | None = None
    review_required: bool = True


class SegmentationAudit(BaseModel):
    provider: str
    base_url: str | None = None
    model: str | None = None
    prompt_count: int = 0
    live_calls: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    available: bool = False
    errors: list[str] = []
    raw_response_path: str | None = None
    raw_response_preview: str | None = None


class RasterWarning(BaseModel):
    code: str
    message: str


class RasterAudit(BaseModel):
    render_dpi: int
    ocr_provider: str
    ocr_live_calls: int
    ocr_cache_hits: int
    ocr_cache_misses: int
    segmentation_provider: str
    falcon_live_calls: int
    falcon_cache_hits: int
    falcon_cache_misses: int
    candidate_count: int
    selected_candidate_id: str
    human_review_status: str


class RasterPipelineResponse(BaseModel):
    document_id: str
    pipeline: str = "raster_first"
    human_review_status: str = "required"
    render: RasterRenderMetadata
    sheet_regions: list[RasterSheetRegion]
    text_blocks: list[RasterTextBlock]
    image_derived_primitives: list[ImageDerivedPrimitive]
    segmentation_candidates: list[SegmentationCandidate]
    production_schema: ProductionSchema
    warnings: list[RasterWarning]
    ocr_audit: OcrAudit
    segmentation_audit: SegmentationAudit
    raster_audit: RasterAudit


class ApprovalRequest(BaseModel):
    approved_by: str
    source: str = "frontend_review"
    target_area: dict[str, Any]
    constraints: dict[str, Any]
    notes: str | None = None


class ApprovalResponse(BaseModel):
    document_id: str
    approval_status: str
    approved_at: str
    export_unlocked: bool


class ExtractRequest(BaseModel):
    force_pipeline: Literal["vector_first", "raster_first"] | None = None
