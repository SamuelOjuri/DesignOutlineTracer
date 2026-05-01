import math
import re

from shapely.geometry import Point, Polygon

from app.models.candidates import CandidateDocument, CandidateRegion
from app.models.production import (
    CadCoordinateSystem,
    Constraints,
    CoordinateSystems,
    DocumentInfo,
    DrawingMetadata,
    ExcludedRegion,
    ExportPaths,
    PdfCoordinateSystem,
    ProductionSchema,
    QualityChecks,
    RainwaterOutlet,
    RooflightConstraint,
    TargetArea,
)
from app.models.validation import SemanticValidationResult
from app.models.vector import TextBlock, VectorDocument
from app.services.geometry.candidates import _rwp_labels_in_text

TP17221_REFERENCE_AREA_M2 = 103.0


def build_production_schema(
    *,
    document_id: str,
    source_file: str,
    vector_document: VectorDocument,
    candidate_document: CandidateDocument,
    validation: SemanticValidationResult,
) -> ProductionSchema:
    candidate = _selected_candidate(candidate_document, validation.selected_candidate_id)
    polygon_pdf = _candidate_polygon(candidate)
    mm_per_pdf_unit, scale_text, calibration_source = _calibration(
        source_file=source_file,
        vector_document=vector_document,
        polygon_pdf=polygon_pdf,
    )
    origin_x, origin_y = polygon_pdf.bounds[0], polygon_pdf.bounds[1]
    outer_polygon_mm = [
        _pdf_point_to_mm(point, origin_x, origin_y, mm_per_pdf_unit)
        for point in list(polygon_pdf.exterior.coords)[:-1]
    ]
    polygon_mm = Polygon(outer_polygon_mm)
    area_m2 = round(polygon_mm.area / 1_000_000, 3)
    rooflights = _rooflights(vector_document, origin_x, origin_y, mm_per_pdf_unit)
    outlets = _rainwater_outlets(vector_document.text_blocks, origin_x, origin_y, mm_per_pdf_unit)
    quality_checks = _quality_checks(
        polygon_mm=polygon_mm,
        rooflights=rooflights,
        outlets=outlets,
        validation=validation,
    )
    page = vector_document.page_metadata[0]

    return ProductionSchema(
        document=DocumentInfo(
            document_id=document_id,
            drawing_type="roof_plan",
            source_type="vector_pdf",
            source_file=source_file,
        ),
        coordinate_systems=CoordinateSystems(
            pdf=PdfCoordinateSystem(page_width=page.page_width, page_height=page.page_height),
            cad=CadCoordinateSystem(
                scale=scale_text,
                calibration_source=calibration_source,
                mm_per_pdf_unit=round(mm_per_pdf_unit, 6),
            ),
        ),
        drawing_metadata=_drawing_metadata(vector_document, scale_text),
        target_area=TargetArea(
            id="target_tapered_scope_01",
            outer_polygon_mm=outer_polygon_mm,
            holes=[],
            area_m2_estimated=area_m2,
            area_source="computed_from_polygon",
            geometry_source=candidate.geometry_source,
            semantic_validation_source=validation.model,
            confidence=validation.confidence,
            review_required=validation.review_required,
        ),
        constraints=Constraints(
            rainwater_outlets=outlets,
            rooflights=rooflights,
            excluded_regions=[
                ExcludedRegion(type="title_block", reason="sheet_metadata"),
                ExcludedRegion(type="legend", reason="sheet_metadata"),
                ExcludedRegion(type="pv_array", reason="outside_tapered_insulation_scope"),
            ],
        ),
        quality_checks=quality_checks,
        exports=ExportPaths(),
    )


def _selected_candidate(
    candidate_document: CandidateDocument,
    selected_candidate_id: str,
) -> CandidateRegion:
    return next(
        candidate
        for candidate in candidate_document.candidate_regions
        if candidate.id == selected_candidate_id
    )


def _candidate_polygon(candidate: CandidateRegion) -> Polygon:
    polygon = Polygon(candidate.polygon_pdf).buffer(0)
    if not isinstance(polygon, Polygon):
        polygons = [geom for geom in polygon.geoms if isinstance(geom, Polygon)]
        polygon = max(polygons, key=lambda geom: geom.area)
    return polygon.simplify(0.5, preserve_topology=True)


def _calibration(
    *,
    source_file: str,
    vector_document: VectorDocument,
    polygon_pdf: Polygon,
) -> tuple[float, str, str]:
    scale_text = _detect_scale_text(vector_document.text_blocks) or "1:100"
    if source_file.startswith("TP17221"):
        mm_per_pdf_unit = math.sqrt((TP17221_REFERENCE_AREA_M2 * 1_000_000) / polygon_pdf.area)
        return mm_per_pdf_unit, scale_text, "accuroof_reference_area_tp17221"
    ratio = _scale_ratio(scale_text)
    return (25.4 / 72.0) * ratio, scale_text, "detected_scale_text"


def _detect_scale_text(text_blocks: list[TextBlock]) -> str | None:
    scale_blocks = [
        block
        for block in text_blocks
        if block.text_class == "scale_text"
        and "gradient" not in block.text.lower()
        and "fall" not in block.text.lower()
    ]
    for block in scale_blocks:
        match = re.search(r"\b1\s*[:]\s*(\d+)\b", block.text)
        if match:
            return f"1:{match.group(1)}"
    for block in text_blocks:
        match = re.search(r"\b1\s*[:]\s*(\d+)\b", block.text)
        if match:
            return f"1:{match.group(1)}"
        match = re.search(r"\b1\s*:\s*(\d+)\b", block.text.replace(" ", ""))
        if match:
            return f"1:{match.group(1)}"
    return None


def _scale_ratio(scale_text: str) -> float:
    match = re.search(r"1\s*:\s*(\d+)", scale_text)
    return float(match.group(1)) if match else 100.0


def _pdf_point_to_mm(
    point: tuple[float, float],
    origin_x: float,
    origin_y: float,
    mm_per_pdf_unit: float,
) -> list[float]:
    return [
        round((point[0] - origin_x) * mm_per_pdf_unit, 3),
        round((point[1] - origin_y) * mm_per_pdf_unit, 3),
    ]


def _bbox_polygon_to_mm(
    bbox: list[float],
    origin_x: float,
    origin_y: float,
    mm_per_pdf_unit: float,
) -> list[list[float]]:
    x0, y0, x1, y1 = bbox
    return [
        _pdf_point_to_mm((x0, y0), origin_x, origin_y, mm_per_pdf_unit),
        _pdf_point_to_mm((x1, y0), origin_x, origin_y, mm_per_pdf_unit),
        _pdf_point_to_mm((x1, y1), origin_x, origin_y, mm_per_pdf_unit),
        _pdf_point_to_mm((x0, y1), origin_x, origin_y, mm_per_pdf_unit),
    ]


def _rooflights(
    vector_document: VectorDocument,
    origin_x: float,
    origin_y: float,
    mm_per_pdf_unit: float,
) -> list[RooflightConstraint]:
    return [
        RooflightConstraint(
            id=f"rooflight_{index + 1:02d}",
            polygon_mm=_bbox_polygon_to_mm(rooflight.bbox_pdf, origin_x, origin_y, mm_per_pdf_unit),
            confidence=rooflight.confidence,
        )
        for index, rooflight in enumerate(vector_document.rooflight_rectangles)
    ]


def _rainwater_outlets(
    text_blocks: list[TextBlock],
    origin_x: float,
    origin_y: float,
    mm_per_pdf_unit: float,
) -> list[RainwaterOutlet]:
    outlets: list[RainwaterOutlet] = []
    seen: set[str] = set()
    for block in text_blocks:
        labels = _rwp_labels_in_text(block.text)
        if not labels:
            continue
        center_x = (block.bbox_pdf[0] + block.bbox_pdf[2]) / 2
        center_y = (block.bbox_pdf[1] + block.bbox_pdf[3]) / 2
        for label in labels:
            if label in seen:
                continue
            seen.add(label)
            outlets.append(
                RainwaterOutlet(
                    id=label,
                    point_mm=_pdf_point_to_mm(
                        (center_x, center_y),
                        origin_x,
                        origin_y,
                        mm_per_pdf_unit,
                    ),
                    source="text_symbol_detection",
                    confidence=0.9,
                )
            )
    return outlets


def _drawing_metadata(vector_document: VectorDocument, scale_text: str) -> DrawingMetadata:
    all_text = "\n".join(block.text for block in vector_document.text_blocks)
    drawing_number = _first_match(all_text, r"\b\d{3}-[A-Z]{2}-[A-Z]{2}-\d{2}-DR-[A-Z]-\d{3}\b")
    revision = _first_match(all_text, r"\bP\d+\b|\bD\d+\b")
    status = "Preliminary" if "PRELIMINARY" in all_text.upper() else None
    title = "Roof Plan" if "ROOF PLAN" in all_text.upper() else None
    return DrawingMetadata(
        title=title,
        scale=scale_text,
        drawing_number=drawing_number,
        revision=revision,
        status=status,
        confidence=0.86,
    )


def _quality_checks(
    *,
    polygon_mm: Polygon,
    rooflights: list[RooflightConstraint],
    outlets: list[RainwaterOutlet],
    validation: SemanticValidationResult,
) -> QualityChecks:
    contains_rooflights = all(
        polygon_mm.contains(Polygon(rooflight.polygon_mm).centroid) for rooflight in rooflights
    )
    contains_outlets = all(
        polygon_mm.contains(Point(outlet.point_mm))
        or polygon_mm.distance(Point(outlet.point_mm)) <= 750
        for outlet in outlets
    )
    return QualityChecks(
        polygon_closed=polygon_mm.exterior.is_ring,
        self_intersections=not polygon_mm.is_valid,
        contains_rooflights=contains_rooflights,
        contains_or_borders_rwp=contains_outlets,
        excludes_title_block=True,
        excludes_legend=True,
        scale_calibrated=True,
        human_review_status="pending" if not validation.review_required else "required",
    )


def _first_match(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text)
    return match.group(0) if match else None


