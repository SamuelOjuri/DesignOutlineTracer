"""Domain models for semantic anchors extracted from a roof-plan image.

Semantic anchors are point-like or box-like features derived from a vision-language
model (e.g. Gemini Robotics-ER 1.5) that mark locations of drainage outlets,
rooflights, fall arrows, PV arrays and similar drawing features. They are
candidate-region inputs and constraint inputs for the downstream tapered
insulation CAD engine. They are not the source of truth for CAD geometry.
"""

from typing import Literal

from pydantic import BaseModel, Field

AnchorClass = Literal[
    "rwp",
    "rooflight",
    "fall_arrow",
    "pv_array",
    "parapet_corner",
    "hopper",
    "sump",
    "scale_bar",
    "other",
]

AnchorProviderName = Literal["mock", "gemini_er"]


class AnchorHints(BaseModel):
    """Inputs that scope an anchor extraction request."""

    document_id: str
    source_file: str
    crop_bbox_px: list[int] | None = None
    image_width_px: int
    image_height_px: int


class SemanticAnchor(BaseModel):
    """Normalized point or box anchor returned from a vision-language model.

    Points are stored in both normalized [y, x] (0-1000) coordinates exactly as
    returned by Gemini Robotics-ER, and converted to image pixel coordinates
    [x_px, y_px] for downstream pipeline consumption.
    """

    id: str
    anchor_class: AnchorClass = Field(alias="class")
    label: str
    point_norm: list[int] | None = None  # [y, x] in 0..1000
    point_px: list[float] | None = None  # [x, y] in image pixel space
    bbox_norm: list[int] | None = None  # [ymin, xmin, ymax, xmax] in 0..1000
    bbox_px: list[float] | None = None  # [xmin, ymin, xmax, ymax] in pixel space
    provider: AnchorProviderName
    semantic_confidence: float = Field(ge=0, le=1)

    model_config = {"populate_by_name": True}


class AnchorAudit(BaseModel):
    provider: AnchorProviderName
    model: str | None = None
    prompt_count: int = 0
    live_calls: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    available: bool = False
    errors: list[str] = []


class AnchorExtractionResult(BaseModel):
    anchors: list[SemanticAnchor]
    audit: AnchorAudit
