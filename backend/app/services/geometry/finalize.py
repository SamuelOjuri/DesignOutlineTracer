import re
from dataclasses import dataclass

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, snap, unary_union

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
from app.models.vector import TextBlock, VectorDocument, VectorPrimitive
from app.services.geometry.candidates import _rwp_labels_in_text
from app.services.geometry.safety import cap_confidence_for_safety, select_candidate_for_validation


@dataclass(frozen=True)
class CalibrationResult:
    mm_per_pdf_unit: float
    scale_text: str
    source: str
    confidence: float
    requires_user_confirmation: bool


def build_production_schema(
    *,
    document_id: str,
    source_file: str,
    vector_document: VectorDocument,
    candidate_document: CandidateDocument,
    validation: SemanticValidationResult,
) -> ProductionSchema:
    selection = select_candidate_for_validation(
        candidate_document,
        validation.selected_review_candidate_id or validation.selected_candidate_id,
    )
    candidate = selection.candidate
    polygon_pdf = _candidate_polygon(candidate, vector_document)
    calibration = _calibration(vector_document=vector_document)
    origin_x, origin_y = polygon_pdf.bounds[0], polygon_pdf.bounds[1]
    outer_polygon_mm = [
        _pdf_point_to_mm(point, origin_x, origin_y, calibration.mm_per_pdf_unit)
        for point in list(polygon_pdf.exterior.coords)[:-1]
    ]
    polygon_mm = Polygon(outer_polygon_mm)
    area_m2 = round(polygon_mm.area / 1_000_000, 3)
    rooflights = _rooflights(
        vector_document,
        polygon_pdf,
        origin_x,
        origin_y,
        calibration.mm_per_pdf_unit,
    )
    outlets = _rainwater_outlets(
        vector_document,
        polygon_pdf,
        origin_x,
        origin_y,
        calibration.mm_per_pdf_unit,
    )
    review_required = (
        validation.review_required
        or candidate.review_required
        or calibration.requires_user_confirmation
        or not candidate.eligible_for_auto_export
        or not candidate.eligible_for_final_dxf
        or selection.demoted
    )
    quality_checks = _quality_checks(
        polygon_pdf=polygon_pdf,
        polygon_mm=polygon_mm,
        rooflights=rooflights,
        outlets=outlets,
        vector_document=vector_document,
        validation=validation,
        candidate=candidate,
        calibration=calibration,
        review_required=review_required,
        selection_warnings=selection.warnings,
    )
    target_confidence = _target_confidence(
        validation=validation,
        candidate=candidate,
        quality_checks=quality_checks,
        demoted=selection.demoted,
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
                scale=calibration.scale_text,
                calibration_source=calibration.source,
                mm_per_pdf_unit=round(calibration.mm_per_pdf_unit, 6),
                calibration_confidence=calibration.confidence,
                requires_user_confirmation=calibration.requires_user_confirmation,
            ),
        ),
        drawing_metadata=_drawing_metadata(vector_document, calibration.scale_text),
        target_area=TargetArea(
            id="target_tapered_scope_01",
            outer_polygon_mm=outer_polygon_mm,
            holes=[],
            area_m2_estimated=area_m2,
            area_source="computed_from_polygon",
            geometry_source=candidate.geometry_source,
            semantic_validation_source=validation.model,
            confidence=target_confidence,
            review_required=review_required,
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


def _candidate_polygon(candidate: CandidateRegion, vector_document: VectorDocument) -> Polygon:
    polygon = Polygon(candidate.polygon_pdf).buffer(0)
    if not isinstance(polygon, Polygon):
        polygons = [geom for geom in polygon.geoms if isinstance(geom, Polygon)]
        polygon = max(polygons, key=lambda geom: geom.area)
    polygon = _snap_polygon_to_vector_linework(polygon, vector_document)
    polygon = _remove_spike_vertices(polygon)
    polygon = _remove_collinear_vertices(polygon)
    return polygon.simplify(0.5, preserve_topology=True)


def _snap_polygon_to_vector_linework(polygon: Polygon, vector_document: VectorDocument) -> Polygon:
    if polygon.is_empty:
        return polygon
    linework: list[LineString] = []
    for primitive in vector_document.vector_primitives:
        if primitive.type != "line" or primitive.start_pdf is None or primitive.end_pdf is None:
            continue
        if primitive.semantic_role not in {"roof_perimeter", "parapet_or_wall", "unknown"}:
            continue
        start = primitive.start_pdf
        end = primitive.end_pdf
        if _distance((start[0], start[1]), (end[0], end[1])) < 45:
            continue
        linework.append(LineString([start, end]))
    if not linework:
        return polygon
    snapped = snap(polygon, unary_union(linework), 2.0)
    if isinstance(snapped, Polygon):
        return snapped.buffer(0)
    polygons = [geom for geom in getattr(snapped, "geoms", []) if isinstance(geom, Polygon)]
    return max(polygons, key=lambda geom: geom.area).buffer(0) if polygons else polygon


def _snap_value(value: float, candidates: list[float], *, tolerance: float) -> float:
    if not candidates:
        return value
    nearest = min(candidates, key=lambda candidate: abs(candidate - value))
    return nearest if abs(nearest - value) <= tolerance else value


def _remove_spike_vertices(polygon: Polygon) -> Polygon:
    points = list(polygon.exterior.coords)[:-1]
    if len(points) < 4:
        return polygon
    cleaned: list[tuple[float, float]] = []
    for index, current in enumerate(points):
        previous = points[index - 1]
        following = points[(index + 1) % len(points)]
        if _distance(previous, following) <= 4.0 and min(
            _distance(previous, current),
            _distance(current, following),
        ) >= 20.0:
            continue
        if cleaned and _distance(cleaned[-1], current) <= 0.5:
            continue
        cleaned.append((float(current[0]), float(current[1])))
    return _clean_polygon(cleaned) or polygon


def _remove_collinear_vertices(polygon: Polygon) -> Polygon:
    points = list(polygon.exterior.coords)[:-1]
    if len(points) < 4:
        return polygon
    cleaned: list[tuple[float, float]] = []
    for index, current in enumerate(points):
        previous = points[index - 1]
        following = points[(index + 1) % len(points)]
        if _is_axis_collinear(previous, current, following):
            continue
        cleaned.append((float(current[0]), float(current[1])))
    return _clean_polygon(cleaned) or polygon


def _is_axis_collinear(
    previous: tuple[float, float],
    current: tuple[float, float],
    following: tuple[float, float],
) -> bool:
    same_x = max(abs(previous[0] - current[0]), abs(current[0] - following[0])) <= 1.0
    same_y = max(abs(previous[1] - current[1]), abs(current[1] - following[1])) <= 1.0
    return bool(same_x or same_y)


def _clean_polygon(points: list[tuple[float, float]] | list[list[float]]) -> Polygon | None:
    if len(points) < 3:
        return None
    cleaned = Polygon(points).buffer(0)
    if isinstance(cleaned, Polygon):
        return cleaned
    polygons = [geom for geom in cleaned.geoms if isinstance(geom, Polygon)]
    return max(polygons, key=lambda geom: geom.area) if polygons else None


def _calibration(*, vector_document: VectorDocument) -> CalibrationResult:
    detected_scale_text = _detect_scale_text(vector_document.text_blocks)
    if detected_scale_text:
        ratio = _scale_ratio(detected_scale_text)
        return CalibrationResult(
            mm_per_pdf_unit=(25.4 / 72.0) * ratio,
            scale_text=detected_scale_text,
            source="detected_scale_text",
            confidence=0.68,
            requires_user_confirmation=True,
        )
    fallback_scale_text = "1:100"
    ratio = _scale_ratio(fallback_scale_text)
    return CalibrationResult(
        mm_per_pdf_unit=(25.4 / 72.0) * ratio,
        scale_text=fallback_scale_text,
        source="uncalibrated_fallback_scale",
        confidence=0.25,
        requires_user_confirmation=True,
    )


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
    polygon_pdf: Polygon,
    origin_x: float,
    origin_y: float,
    mm_per_pdf_unit: float,
) -> list[RooflightConstraint]:
    rooflights: list[RooflightConstraint] = []
    target_region = polygon_pdf.buffer(8.0)
    pv_regions = _pv_text_regions(vector_document.text_blocks)
    for rooflight in vector_document.rooflight_rectangles:
        center = Point(_bbox_center_tuple(rooflight.bbox_pdf))
        if not target_region.contains(center):
            continue
        if any(region.buffer(8.0).contains(center) for region in pv_regions):
            continue
        supported_by_text = _rooflight_supported_by_text(
            rooflight.bbox_pdf,
            vector_document.text_blocks,
        )
        recovered_symbol = rooflight.source == "raster_crosshatched_rooflight_symbol"
        confidence = rooflight.confidence
        if supported_by_text:
            confidence = min(1.0, confidence + 0.08)
        elif recovered_symbol and _has_rooflight_expectation(vector_document.text_blocks):
            confidence = max(0.58, confidence - 0.04)
        elif confidence < 0.78:
            continue
        else:
            confidence = max(0.55, confidence - 0.12)
        rooflights.append(
            RooflightConstraint(
                id=f"rooflight_{len(rooflights) + 1:02d}",
                polygon_mm=_bbox_polygon_to_mm(
                    rooflight.bbox_pdf,
                    origin_x,
                    origin_y,
                    mm_per_pdf_unit,
                ),
                confidence=round(confidence, 3),
            )
        )
    return rooflights


def _rainwater_outlets(
    vector_document: VectorDocument,
    polygon_pdf: Polygon,
    origin_x: float,
    origin_y: float,
    mm_per_pdf_unit: float,
) -> list[RainwaterOutlet]:
    outlets: list[RainwaterOutlet] = []
    seen: set[str] = set()
    association_tolerance = max(45.0, min(110.0, 750.0 / max(mm_per_pdf_unit, 0.001)))
    border_tolerance = max(2.0, min(25.0, 750.0 / max(mm_per_pdf_unit, 0.001)))
    target_region = polygon_pdf.buffer(association_tolerance)
    for block in vector_document.text_blocks:
        labels = _rwp_labels_in_text(block.text)
        if not labels:
            continue
        label_points = _distributed_label_points(block.bbox_pdf, len(labels))
        for label, label_point in zip(labels, label_points, strict=True):
            if label in seen:
                continue
            seen.add(label)
            outlet_point, source, confidence = _nearest_outlet_geometry(
                vector_document.vector_primitives,
                label_point,
            )
            outlet_pdf = Point(outlet_point)
            if not target_region.contains(outlet_pdf):
                continue
            if not polygon_pdf.buffer(border_tolerance).contains(outlet_pdf):
                boundary_point = nearest_points(polygon_pdf.boundary, outlet_pdf)[0]
                outlet_point = (float(boundary_point.x), float(boundary_point.y))
                source = f"{source}_snapped_to_target_boundary"
                confidence = max(0.55, confidence - 0.08)
            outlets.append(
                RainwaterOutlet(
                    id=label,
                    point_mm=_pdf_point_to_mm(
                        outlet_point,
                        origin_x,
                        origin_y,
                        mm_per_pdf_unit,
                    ),
                    source=source,
                    confidence=confidence,
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
    polygon_pdf: Polygon,
    polygon_mm: Polygon,
    rooflights: list[RooflightConstraint],
    outlets: list[RainwaterOutlet],
    vector_document: VectorDocument,
    validation: SemanticValidationResult,
    candidate: CandidateRegion,
    calibration: CalibrationResult,
    review_required: bool,
    selection_warnings: list[str],
) -> QualityChecks:
    rooflight_expected = _has_rooflight_expectation(vector_document.text_blocks)
    outlet_expected = _has_rwp_expectation(vector_document.text_blocks)
    contains_rooflights = (
        all(polygon_mm.contains(Polygon(rooflight.polygon_mm).centroid) for rooflight in rooflights)
        if rooflights
        else not rooflight_expected
    )
    contains_outlets = (
        all(
            polygon_mm.contains(Point(outlet.point_mm))
            or polygon_mm.distance(Point(outlet.point_mm)) <= 750
            for outlet in outlets
        )
        if outlets
        else not outlet_expected
    )
    outlet_geometry_confidence = (
        round(sum(outlet.confidence for outlet in outlets) / len(outlets), 3) if outlets else 0.0
    )
    excludes_title_block = _excludes_sheet_regions(polygon_pdf, vector_document, {"title_block"})
    excludes_legend = _excludes_sheet_regions(polygon_pdf, vector_document, {"legend"})
    warnings = [*candidate.quality_warnings, *candidate.safety_warnings, *selection_warnings]
    if candidate.geometry_source == "coarse_semantic_search_area":
        warnings.append("coarse_candidate_not_cad_final")
    if candidate.safety_status == "blocked":
        warnings.append("selected_candidate_failed_safety_gate")
    if not contains_rooflights:
        warnings.append("rooflight_detection_requires_review")
    if not excludes_title_block:
        warnings.append("target_overlaps_title_block")
    if not excludes_legend:
        warnings.append("target_overlaps_legend")
    if calibration.requires_user_confirmation:
        warnings.append("scale_requires_user_confirmation")
    if outlet_geometry_confidence < 0.7:
        warnings.append("outlet_geometry_requires_review")
    if validation.review_required:
        warnings.append("semantic_validation_requires_review")

    return QualityChecks(
        polygon_closed=polygon_mm.exterior.is_ring,
        self_intersections=not polygon_mm.is_valid,
        contains_rooflights=contains_rooflights,
        contains_or_borders_rwp=contains_outlets,
        excludes_title_block=excludes_title_block,
        excludes_legend=excludes_legend,
        scale_calibrated=calibration.confidence >= 0.6,
        cad_candidate_exportable=(
            candidate.eligible_for_auto_export and candidate.eligible_for_final_dxf
            and not review_required
            and not calibration.requires_user_confirmation
            and not validation.review_required
        ),
        calibration_confidence=calibration.confidence,
        outlet_geometry_confidence=outlet_geometry_confidence,
        warnings=sorted(set(warnings)),
        human_review_status="required" if review_required else "pending",
    )


def _target_confidence(
    *,
    validation: SemanticValidationResult,
    candidate: CandidateRegion,
    quality_checks: QualityChecks,
    demoted: bool,
) -> float:
    confidence = min(validation.confidence, max(candidate.score, candidate.geometry_confidence))
    confidence = cap_confidence_for_safety(confidence, candidate=candidate, demoted=demoted)
    if not quality_checks.contains_rooflights:
        confidence = min(confidence, 0.58)
    if "candidate_area_outlier" in quality_checks.warnings:
        confidence = min(confidence, 0.55)
    if quality_checks.human_review_status == "required":
        confidence = min(confidence, 0.7)
    return round(confidence, 4)


def _excludes_sheet_regions(
    polygon_pdf: Polygon,
    vector_document: VectorDocument,
    region_types: set[str],
) -> bool:
    if polygon_pdf.area <= 0:
        return False
    regions = [
        box(*region.bbox_pdf)
        for region in vector_document.sheet_regions
        if region.type in region_types
    ]
    return not any(
        polygon_pdf.intersects(region)
        and polygon_pdf.intersection(region).area / polygon_pdf.area > 0.01
        for region in regions
    )


def _has_rooflight_expectation(text_blocks: list[TextBlock]) -> bool:
    return any(
        re.search(r"roof\s*light|rooflight", block.text, flags=re.IGNORECASE)
        for block in text_blocks
    )


def _has_rwp_expectation(text_blocks: list[TextBlock]) -> bool:
    return any(_rwp_labels_in_text(block.text) for block in text_blocks)


def _pv_text_regions(text_blocks: list[TextBlock]) -> list[Polygon]:
    return [
        box(*_expand_bbox(block.bbox_pdf, 28, 10_000, 10_000))
        for block in text_blocks
        if re.search(r"\bpv\b|photovoltaic|solar\s+array", block.text, flags=re.IGNORECASE)
    ]


def _rooflight_supported_by_text(bbox: list[float], text_blocks: list[TextBlock]) -> bool:
    return any(
        re.search(r"roof\s*light|rooflight", block.text, flags=re.IGNORECASE)
        and _distance(_bbox_center_tuple(bbox), _bbox_center_tuple(block.bbox_pdf)) <= 220
        for block in text_blocks
    )


def _bbox_center_tuple(bbox: list[float]) -> tuple[float, float]:
    return (float((bbox[0] + bbox[2]) / 2), float((bbox[1] + bbox[3]) / 2))


def _expand_bbox(
    bbox: list[float],
    padding: float,
    max_width: float,
    max_height: float,
) -> list[float]:
    return [
        max(0.0, bbox[0] - padding),
        max(0.0, bbox[1] - padding),
        min(max_width, bbox[2] + padding),
        min(max_height, bbox[3] + padding),
    ]


def _first_match(text: str, pattern: str) -> str | None:
    match = re.search(pattern, text)
    return match.group(0) if match else None


def _distributed_label_points(bbox: list[float], count: int) -> list[tuple[float, float]]:
    if count <= 1:
        return [((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)]
    y = (bbox[1] + bbox[3]) / 2
    width = bbox[2] - bbox[0]
    if width <= 0:
        center = ((bbox[0] + bbox[2]) / 2, y)
        return [center for _ in range(count)]
    step = width / (count + 1)
    return [(bbox[0] + step * (index + 1), y) for index in range(count)]


def _nearest_outlet_geometry(
    primitives: list[VectorPrimitive],
    label_point: tuple[float, float],
) -> tuple[tuple[float, float], str, float]:
    best_point = label_point
    best_distance = 180.0
    best_confidence = 0.55
    best_source = "text_label_estimate"
    for primitive in primitives:
        if primitive.semantic_role not in {"drainage_symbol", "leader_line", "unknown"}:
            continue
        if primitive.type not in {"line", "curve", "rect"}:
            continue
        if _bbox_size(primitive.bbox_pdf) > 240:
            continue
        point = _primitive_anchor_point(primitive, label_point)
        distance = _distance(point, label_point)
        if distance < best_distance:
            best_point = point
            best_distance = distance
            best_confidence = 0.78 if primitive.semantic_role == "drainage_symbol" else 0.68
            best_source = "symbol_or_leader_detection"
    return best_point, best_source, best_confidence


def _primitive_anchor_point(
    primitive: VectorPrimitive,
    label_point: tuple[float, float],
) -> tuple[float, float]:
    if (
        primitive.type == "line"
        and primitive.start_pdf is not None
        and primitive.end_pdf is not None
    ):
        start = (primitive.start_pdf[0], primitive.start_pdf[1])
        end = (primitive.end_pdf[0], primitive.end_pdf[1])
        return start if _distance(start, label_point) <= _distance(end, label_point) else end
    bbox = primitive.bbox_pdf
    return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2


def _bbox_size(bbox: list[float]) -> float:
    return float(max(bbox[2] - bbox[0], bbox[3] - bbox[1]))


def _distance(left: tuple[float, float], right: tuple[float, float]) -> float:
    return float(((left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2) ** 0.5)


