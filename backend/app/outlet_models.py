"""Outlet review contracts. Anchors and scope geometry use immutable page pixels."""
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import Field, StrictInt, model_validator

from .models import AcceptedRoi, Contract, Geometry, Identifier, ModelName, Sha256
from .outline_models import NormalizedPoint, OutlinePoint, WarningList


OutletSubtype = Literal["internal_outlet", "parapet_outlet", "scupper"]
Ring = Annotated[list[OutlinePoint], Field(min_length=3, max_length=512)]


class ScopePolygon(Contract):
    outer: Ring
    holes: Annotated[list[Ring], Field(max_length=64)] = Field(default_factory=list)


class OutletScope(Contract):
    roi_id: Identifier
    outline_id: Identifier
    polygons: Annotated[list[ScopePolygon], Field(min_length=1, max_length=32)]
    # Preserve exclusion semantics where a cutout touches the exterior and the
    # boolean difference represents its edge as part of an outer ring.
    excluded_openings: Annotated[list[Ring], Field(max_length=128)] = Field(default_factory=list)


class OutletInput(Contract):
    contract_version: Literal["outlet-1"]
    page_id: Identifier
    request_id: Identifier
    source_image_hash: Sha256
    roi_revision: Annotated[StrictInt, Field(ge=0)]
    geometry_revision: Annotated[StrictInt, Field(ge=0)]
    scope_signature: Annotated[str, Field(min_length=1, max_length=256)]
    accepted_rois: Annotated[list[AcceptedRoi], Field(min_length=1, max_length=25)]
    scopes: Annotated[list[OutletScope], Field(min_length=1, max_length=25)]

    @model_validator(mode="after")
    def associations(self):
        parents = {roi.id for roi in self.accepted_rois}
        if len(parents) != len(self.accepted_rois):
            raise ValueError("duplicate_parents")
        identities = [(scope.roi_id, scope.outline_id) for scope in self.scopes]
        if len(set(identities)) != len(identities) or any(scope.roi_id not in parents for scope in self.scopes):
            raise ValueError("invalid_scope_association")
        if (sum(len(ring) for scope in self.scopes for polygon in scope.polygons
                for ring in [polygon.outer, *polygon.holes])
                + sum(len(ring) for scope in self.scopes for ring in scope.excluded_openings)) > 8192:
            raise ValueError("scope_geometry_too_large")
        return self


class ModelOutlet(Geometry):
    label: Annotated[str, Field(min_length=1, max_length=240)]
    subtype: OutletSubtype
    anchor: NormalizedPoint
    evidence: Annotated[str, Field(min_length=1, max_length=1000)]

    @model_validator(mode="after")
    def inlet_inside_symbol(self):
        top, left, bottom, right = self.box_2d
        if not self.label.strip() or not self.evidence.strip():
            raise ValueError("blank_outlet_evidence")
        if not left <= self.anchor.x <= right or not top <= self.anchor.y <= bottom:
            raise ValueError("anchor_outside_symbol")
        return self


class OutletAnnotation(Geometry):
    id: Identifier
    page_id: Identifier
    kind: Literal["rainwater_outlet"] = "rainwater_outlet"
    label: str
    subtype: OutletSubtype
    proposed_box_2d: tuple[float, float, float, float]
    anchor: OutlinePoint
    proposed_anchor: OutlinePoint
    roi_id: Identifier
    outline_id: Identifier
    origin: Literal["gemini"] = "gemini"
    review_status: Literal["suggested"] = "suggested"
    validity: Literal["current", "needs_review"] = "current"
    revision: Literal[1] = 1
    edits: list = Field(default_factory=list)
    warnings: WarningList = Field(default_factory=list)
    evidence: str


class OutletResponse(Contract):
    contract_version: Literal["outlet-1"] = "outlet-1"
    page_id: Identifier
    request_id: Identifier
    source_image_hash: Sha256
    scope_signature: str
    status: Literal["complete", "partial", "no_detections"]
    annotations: list[OutletAnnotation]
    warnings: WarningList
    model: ModelName
    prompt_version: str
    run: dict


@dataclass
class CachedOutlets:
    response: OutletResponse
    expires: float
