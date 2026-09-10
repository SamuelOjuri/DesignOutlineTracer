from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, model_validator


MODEL = "gemini-3.6-flash"
Task = Literal["roof_roi", "penetration", "rainwater_outlet"]
Identifier = Annotated[str, Field(min_length=1, max_length=200, pattern=r"^[a-zA-Z0-9_-]+$")]
Sha256 = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
Coordinate = Annotated[StrictFloat | StrictInt, Field(ge=0, le=1000, allow_inf_nan=False)]
Box = tuple[Coordinate, Coordinate, Coordinate, Coordinate]
SUBTYPES = {
    "roof_roi": (),
    "penetration": ("rooflight", "vent", "flue", "access_hatch"),
    "rainwater_outlet": ("internal_outlet", "parapet_outlet", "scupper"),
}


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Geometry(Contract):
    box_2d: Box

    @model_validator(mode="after")
    def ordered_box(self) -> Self:
        ymin, xmin, ymax, xmax = self.box_2d
        if ymin >= ymax or xmin >= xmax:
            raise ValueError("invalid_box_order")
        return self


class PageContext(Contract):
    document_id: Identifier
    file_name: Annotated[str, Field(min_length=1, max_length=255)]
    page_id: Identifier
    page_index: Annotated[StrictInt, Field(ge=0)]
    source_image_hash: Sha256
    source_width: Annotated[StrictInt, Field(gt=0)]
    source_height: Annotated[StrictInt, Field(gt=0)]
    render_scale: Annotated[StrictFloat, Field(gt=0)]
    render_rotation: Literal[0, 90, 180, 270]
    render_version: Annotated[str, Field(min_length=1, max_length=160)]
    pdf_view_box: tuple[StrictFloat, StrictFloat, StrictFloat, StrictFloat]


class AcceptedRoi(Geometry):
    id: Identifier
    revision: Annotated[StrictInt, Field(ge=1)]


class DetectionInput(Contract):
    page_id: Identifier
    request_id: Identifier
    task: Task
    source_image_hash: Sha256
    roi_revision: Annotated[StrictInt, Field(ge=0)] | None
    geometry_revision: Annotated[StrictInt, Field(ge=0)]
    accepted_rois: Annotated[list[AcceptedRoi], Field(max_length=25)] = Field(default_factory=list)
    follow_up_of: Identifier | None = None

    @model_validator(mode="after")
    def valid_parents(self) -> Self:
        if self.task == "roof_roi":
            if self.accepted_rois or self.roi_revision is not None:
                raise ValueError("unexpected_parents")
        elif not self.accepted_rois or self.roi_revision is None:
            raise ValueError("accepted_parents_required")
        if len({parent.id for parent in self.accepted_rois}) != len(self.accepted_rois):
            raise ValueError("duplicate_parents")
        return self


class Proposal(Geometry):
    label: Annotated[str, Field(min_length=1, max_length=240)]
    roi_id: Identifier | None = None
    subtype: str | None = None

    @model_validator(mode="after")
    def nonblank_label(self) -> Self:
        if not self.label.strip():
            raise ValueError("invalid_label")
        return self


class Annotation(Proposal):
    id: Identifier
    page_id: Identifier
    kind: Task
    proposed_box_2d: Box
    origin: Literal["gemini"] = "gemini"
    review_status: Literal["suggested"] = "suggested"
    validity: Literal["current"] = "current"
    revision: Literal[1] = 1
    edits: list = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class DetectionRun(Contract):
    page_id: Identifier
    request_id: Identifier
    task: Task
    source_image_hash: Sha256
    roi_revision: int | None
    geometry_revision: int
    model: Literal["gemini-3.6-flash"] = MODEL
    prompt_version: str
    schema_version: Literal["1"] = "1"
    settings: dict
    started_at: str
    duration_ms: float
    status: Literal["complete", "no_detections", "partial"]
    warnings: list[str]
    cached: bool
    provider_attempts: int


class DetectionResponse(Contract):
    schema_version: Literal["1"] = "1"
    page_id: Identifier
    request_id: Identifier
    task: Task
    status: Literal["complete", "no_detections", "partial"]
    roi_revision: int | None
    model: Literal["gemini-3.6-flash"] = MODEL
    prompt_version: str
    annotations: list[Annotation]
    warnings: list[str]
    run: DetectionRun