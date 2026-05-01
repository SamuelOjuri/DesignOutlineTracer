from typing import Literal

from pydantic import BaseModel, Field

ExportFormat = Literal["dxf", "svg", "geojson", "mask_png", "metadata_json"]
ExportPipeline = Literal["vector", "raster"]


class ExportRequest(BaseModel):
    formats: list[ExportFormat] = ["dxf", "svg", "geojson", "mask_png", "metadata_json"]
    pipeline: ExportPipeline = "vector"


class DocumentInfo(BaseModel):
    document_id: str
    drawing_type: str
    source_type: str
    source_file: str


class PdfCoordinateSystem(BaseModel):
    units: str = "pdf_points"
    page_width: float
    page_height: float


class CadCoordinateSystem(BaseModel):
    units: str = "mm"
    scale: str
    calibration_source: str
    mm_per_pdf_unit: float


class CoordinateSystems(BaseModel):
    pdf: PdfCoordinateSystem
    cad: CadCoordinateSystem


class DrawingMetadata(BaseModel):
    title: str | None
    scale: str | None
    drawing_number: str | None
    revision: str | None
    status: str | None
    confidence: float = Field(ge=0, le=1)


class TargetArea(BaseModel):
    id: str
    type: str = "tapered_insulation_scope"
    outer_polygon_mm: list[list[float]]
    holes: list[list[list[float]]]
    area_m2_estimated: float
    area_source: str
    geometry_source: str
    semantic_validation_source: str
    confidence: float = Field(ge=0, le=1)
    review_required: bool


class RainwaterOutlet(BaseModel):
    id: str
    type: str = "rainwater_downpipe"
    point_mm: list[float]
    source: str
    confidence: float = Field(ge=0, le=1)


class RooflightConstraint(BaseModel):
    id: str
    polygon_mm: list[list[float]]
    treatment: str = "upstand_or_penetration"
    confidence: float = Field(ge=0, le=1)


class ExcludedRegion(BaseModel):
    type: str
    reason: str


class Constraints(BaseModel):
    rainwater_outlets: list[RainwaterOutlet]
    rooflights: list[RooflightConstraint]
    excluded_regions: list[ExcludedRegion]


class QualityChecks(BaseModel):
    polygon_closed: bool
    self_intersections: bool
    contains_rooflights: bool
    contains_or_borders_rwp: bool
    excludes_title_block: bool
    excludes_legend: bool
    scale_calibrated: bool
    human_review_status: str


class ExportPaths(BaseModel):
    dxf: str | None = None
    svg: str | None = None
    geojson: str | None = None
    mask_png: str | None = None
    metadata_json: str | None = None


class ProductionSchema(BaseModel):
    document: DocumentInfo
    coordinate_systems: CoordinateSystems
    drawing_metadata: DrawingMetadata
    target_area: TargetArea
    constraints: Constraints
    quality_checks: QualityChecks
    exports: ExportPaths


class ExportResponse(BaseModel):
    document_id: str
    production_schema: ProductionSchema
    exports: ExportPaths
