from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TextBlockClass = Literal[
    "drawing_title",
    "drawing_status",
    "scale_text",
    "drawing_number",
    "revision",
    "rwp_label",
    "rooflight_label",
    "roof_build_up_note",
    "fall_path_note",
    "title_block_text",
    "general_note",
    "other",
]

VectorPrimitiveType = Literal["line", "curve", "quad", "rect", "other"]
VectorPrimitiveRole = Literal[
    "roof_perimeter",
    "parapet_or_wall",
    "rooflight",
    "hatch",
    "dimension_line",
    "leader_line",
    "fall_arrow",
    "pv_array",
    "title_block",
    "legend",
    "notes",
    "drainage_symbol",
    "unknown",
]
SheetRegionType = Literal["drawing_viewport", "title_block", "legend", "notes"]


class PageMetadata(BaseModel):
    page_number: int
    page_width: float
    page_height: float
    rotation: int
    media_box: list[float]
    crop_box: list[float]


class TextBlock(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    page_number: int
    text: str
    bbox_pdf: list[float]
    source: str = "pdf_text_extraction"
    text_class: TextBlockClass | None = Field(default=None, alias="class")
    semantic_confidence: float | None = None


class ClassifiedTextBlock(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    text_class: TextBlockClass = Field(alias="class")
    semantic_confidence: float
    class_source: str


class VectorPrimitive(BaseModel):
    id: str
    page_number: int
    type: VectorPrimitiveType
    bbox_pdf: list[float]
    start_pdf: list[float] | None = None
    end_pdf: list[float] | None = None
    stroke_width: float
    stroke_colour: list[float] | None = None
    fill_colour: list[float] | None = None
    dash: str | None = None
    source: str = "pymupdf_get_drawings"
    semantic_role: VectorPrimitiveRole = "unknown"


class SheetRegion(BaseModel):
    type: SheetRegionType
    page_number: int
    bbox_pdf: list[float]
    confidence: float


class RooflightRectangle(BaseModel):
    id: str
    page_number: int
    bbox_pdf: list[float]
    source: str
    confidence: float


class VectorExtractionSummary(BaseModel):
    text_block_count: int
    classified_text_block_count: int
    vector_primitive_count: int
    sheet_region_count: int
    rwp_label_count: int
    rwp_labels: list[str]
    rooflight_rectangle_count: int


class VectorDocument(BaseModel):
    document_id: str
    source_file: str
    page_metadata: list[PageMetadata]
    text_blocks: list[TextBlock]
    classified_text_blocks: list[ClassifiedTextBlock]
    vector_primitives: list[VectorPrimitive]
    sheet_regions: list[SheetRegion]
    rooflight_rectangles: list[RooflightRectangle]
    summary: VectorExtractionSummary
