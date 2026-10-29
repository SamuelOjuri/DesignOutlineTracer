"""Versioned contracts for reviewed exterior-outline proposals.

Coordinates in the public response are source-page pixels, independent of zoom.
The provider's crop-relative coordinate contract is deliberately separate.
"""
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import Field, StrictFloat, StrictInt, model_validator

from .models import AcceptedRoi, Contract, Identifier, ModelName, Sha256


BoundaryPolicy = Literal["inner_parapet", "roof_deck", "outer_roof"]
OutlineStatus = Literal["complete", "needs_review", "no_outline", "roi_too_tight"]
Pixel = Annotated[StrictFloat | StrictInt, Field(ge=0, le=10_000_000, allow_inf_nan=False)]
Normalized = Annotated[StrictFloat | StrictInt, Field(ge=0, le=1000, allow_inf_nan=False)]
WarningList = Annotated[list[Annotated[str, Field(min_length=1, max_length=500)]], Field(max_length=50)]


class OutlinePoint(Contract):
    x: Pixel
    y: Pixel


class VectorSegment(Contract):
    start: OutlinePoint
    end: OutlinePoint

    @model_validator(mode="after")
    def nonzero(self):
        if self.start == self.end:
            raise ValueError("zero_length_segment")
        return self


class OutlineInput(Contract):
    schema_version: Literal["outline-1"]
    page_id: Identifier
    request_id: Identifier
    source_image_hash: Sha256
    roi_revision: Annotated[StrictInt, Field(ge=0)]
    geometry_revision: Annotated[StrictInt, Field(ge=0)]
    roi: AcceptedRoi
    boundary_policy: BoundaryPolicy
    boundary_notes: Annotated[str, Field(max_length=1000)] = ""
    vector_segments: Annotated[list[VectorSegment], Field(max_length=2000)] = Field(default_factory=list)


class NormalizedPoint(Contract):
    x: Normalized
    y: Normalized


class ModelPolygon(Contract):
    points: Annotated[list[NormalizedPoint], Field(min_length=3, max_length=128)]


class ModelOutline(Contract):
    polygons: Annotated[list[ModelPolygon], Field(max_length=8)]
    roi_too_tight: bool


class OutlineEdge(Contract):
    index: Annotated[StrictInt, Field(ge=0, le=127)]
    support: Annotated[float, Field(ge=0, le=1, allow_inf_nan=False)]
    source: Literal["vector", "raster", "unsupported"]
    ambiguous: bool


class OutlineProposal(Contract):
    id: Identifier
    points: Annotated[list[OutlinePoint], Field(min_length=3, max_length=128)]
    proposed_points: Annotated[list[OutlinePoint], Field(min_length=3, max_length=128)]
    edges: Annotated[list[OutlineEdge], Field(min_length=3, max_length=128)]
    warnings: WarningList

    @model_validator(mode="after")
    def matching_edges(self):
        if [edge.index for edge in self.edges] != list(range(len(self.points))):
            raise ValueError("outline_edge_identity_mismatch")
        return self


class OutlineCrop(Contract):
    x: Pixel
    y: Pixel
    width: Annotated[StrictInt, Field(gt=0)]
    height: Annotated[StrictInt, Field(gt=0)]
    inference_width: Annotated[StrictInt, Field(gt=0, le=2048)]
    inference_height: Annotated[StrictInt, Field(gt=0, le=2048)]


class OutlineRun(Contract):
    model: ModelName
    prompt_version: str
    algorithm_version: str
    settings: dict
    duration_ms: Annotated[float, Field(ge=0, allow_inf_nan=False)]
    cached: bool
    provider_attempts: Annotated[StrictInt, Field(ge=0, le=2)]


class OutlineResponse(Contract):
    schema_version: Literal["outline-1"] = "outline-1"
    page_id: Identifier
    request_id: Identifier
    source_image_hash: Sha256
    roi_revision: Annotated[StrictInt, Field(ge=0)]
    geometry_revision: Annotated[StrictInt, Field(ge=0)]
    roi_id: Identifier
    roi_annotation_revision: Annotated[StrictInt, Field(ge=1)]
    boundary_policy: BoundaryPolicy
    status: OutlineStatus
    proposals: Annotated[list[OutlineProposal], Field(max_length=8)]
    warnings: WarningList
    crop: OutlineCrop
    run: OutlineRun

    @model_validator(mode="after")
    def consistent_status(self):
        if bool(self.proposals) != (self.status in {"complete", "needs_review"}):
            raise ValueError("outline_status_mismatch")
        return self


@dataclass
class CachedOutline:
    response: OutlineResponse
    expires: float
