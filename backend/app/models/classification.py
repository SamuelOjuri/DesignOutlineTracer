from typing import Literal

from pydantic import BaseModel, Field

SourceType = Literal[
    "dwg_dxf",
    "vector_pdf",
    "hybrid_pdf",
    "rasterized_pdf",
    "image_file",
    "unknown_low_quality_source",
]

RecommendedPipeline = Literal["vector_first", "raster_first", "hybrid", "cad_first"]


class PdfPageMetrics(BaseModel):
    page_number: int
    width_points: float
    height_points: float
    vector_path_count: int
    embedded_image_count: int
    text_character_count: int


class ClassificationResult(BaseModel):
    has_extractable_text: bool
    text_character_count: int
    has_vector_paths: bool
    vector_path_count: int
    embedded_image_count: int
    embedded_image_area_ratio: float = Field(ge=0)
    large_page_image_detected: bool
    recommended_pipeline: RecommendedPipeline
    source_type: SourceType
    page_count: int
    font_count: int
    estimated_dpi: float | None
    confidence: float = Field(ge=0, le=1)
    signals: list[str]
    pages: list[PdfPageMetrics]
