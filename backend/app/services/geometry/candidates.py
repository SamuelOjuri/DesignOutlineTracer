import math
import re
from dataclasses import dataclass

from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import polygonize, unary_union

from app.models.candidates import (
    CandidateDocument,
    CandidateFeatures,
    CandidateGeometrySource,
    CandidateRegion,
    CandidateScores,
    CandidateSummary,
    PipelineProfile,
)
from app.models.vector import TextBlock, VectorDocument
from app.services.scoring.candidate_scoring import score_candidate

MAX_POLYGONIZED_SEGMENTS = 2500
MAX_POLYGONIZED_CANDIDATES = 30
MAX_COMPOSITE_CANDIDATES = 8
MAX_RECONSTRUCTION_CANDIDATES = 4
MIN_FACE_AREA = 500.0
PROXIMITY_TOLERANCE = 80.0
NOTE_PROXIMITY_TOLERANCE = 350.0
COMPOSITE_ANCHOR_TOLERANCE = 180.0
COMPOSITE_NEIGHBOUR_TOLERANCE = 8.0
COARSE_GEOMETRY_SOURCE: CandidateGeometrySource = "coarse_semantic_search_area"
RECONSTRUCTION_GEOMETRY_SOURCE: CandidateGeometrySource = "anchor_boundary_reconstruction"
AUTO_EXPORT_GEOMETRY_SOURCES: set[CandidateGeometrySource] = {
    "anchor_boundary_reconstruction",
    "vector_polygonized_face",
    "vector_composite_region",
    "linework_snapped_semantic_region",
    "raster_contour_polygonisation",
}
RECONSTRUCTION_EXCLUDED_ROLES = {
    "dimension_line",
    "leader_line",
    "fall_arrow",
    "pv_array",
    "title_block",
    "legend",
    "notes",
    "rooflight",
    "drainage_symbol",
}


@dataclass(frozen=True)
class Anchor:
    id: str
    point: Point
    bbox: list[float]


@dataclass(frozen=True)
class ReconstructionCandidate:
    polygon: Polygon
    bridge_count: int
    search_boundary_touch_ratio: float


def generate_candidate_document(
    vector_document: VectorDocument,
    *,
    pipeline_profile: PipelineProfile = "vector",
) -> CandidateDocument:
    rwp_anchors = _rwp_anchors(vector_document.text_blocks)
    note_anchors = _note_anchors(vector_document.text_blocks)
    rooflight_anchors = [
        Anchor(id=rooflight.id, point=_bbox_center(rooflight.bbox_pdf), bbox=rooflight.bbox_pdf)
        for rooflight in vector_document.rooflight_rectangles
    ]
    primitive_anchors = _primitive_anchors(vector_document)
    title_regions = _title_regions(vector_document)
    pv_regions = _pv_regions(vector_document.text_blocks)

    candidates: list[CandidateRegion] = []
    semantic_polygon = _semantic_envelope_candidate(rwp_anchors, rooflight_anchors, vector_document)
    face_polygons = _polygonized_face_candidates(vector_document)

    for index, polygon in enumerate(
        _composite_face_candidates(
            face_polygons=face_polygons,
            search_polygon=semantic_polygon,
            rwp_anchors=rwp_anchors,
            rooflight_anchors=rooflight_anchors,
            note_anchors=note_anchors,
        )
    ):
        candidates.append(
            _build_candidate(
                candidate_id=f"candidate_vector_composite_{index + 1:02d}",
                polygon=polygon,
                geometry_source="vector_composite_region",
                geometry_confidence=0.82,
                vector_document=vector_document,
                rwp_anchors=rwp_anchors,
                rooflight_anchors=rooflight_anchors,
                note_anchors=note_anchors,
                title_regions=title_regions,
                pv_regions=pv_regions,
                pipeline_profile=pipeline_profile,
            )
        )

    for index, reconstruction in enumerate(
        _anchor_boundary_reconstruction_candidates(
            vector_document=vector_document,
            seed_anchors=_reconstruction_seed_anchors(
                rwp_anchors=rwp_anchors,
                primitive_anchors=primitive_anchors,
                rooflight_anchors=rooflight_anchors,
            ),
        )
    ):
        warnings = ["anchor_boundary_reconstruction_requires_review"]
        if reconstruction.bridge_count:
            warnings.append("synthetic_gap_bridges_used")
        if reconstruction.search_boundary_touch_ratio > 0.20:
            warnings.append("partial_search_boundary_closure_used")
        candidates.append(
            _build_candidate(
                candidate_id=f"candidate_vector_anchor_boundary_{index + 1:02d}",
                polygon=reconstruction.polygon,
                geometry_source=RECONSTRUCTION_GEOMETRY_SOURCE,
                geometry_confidence=0.74,
                vector_document=vector_document,
                rwp_anchors=rwp_anchors,
                rooflight_anchors=rooflight_anchors,
                note_anchors=note_anchors,
                title_regions=title_regions,
                pv_regions=pv_regions,
                pipeline_profile=pipeline_profile,
                quality_warnings=warnings,
            )
        )

    if semantic_polygon is not None:
        snapped_polygon = _linework_snapped_semantic_candidate(vector_document, semantic_polygon)
        if snapped_polygon is not None:
            candidates.append(
                _build_candidate(
                    candidate_id="candidate_linework_snapped_semantic_01",
                    polygon=snapped_polygon,
                    geometry_source="linework_snapped_semantic_region",
                    geometry_confidence=0.76,
                    vector_document=vector_document,
                    rwp_anchors=rwp_anchors,
                    rooflight_anchors=rooflight_anchors,
                    note_anchors=note_anchors,
                    title_regions=title_regions,
                    pv_regions=pv_regions,
                    pipeline_profile=pipeline_profile,
                )
            )

    for index, polygon in enumerate(face_polygons):
        candidates.append(
            _build_candidate(
                candidate_id=f"candidate_vector_face_{index + 1:03d}",
                polygon=polygon,
                geometry_source="vector_polygonized_face",
                geometry_confidence=0.88,
                vector_document=vector_document,
                rwp_anchors=rwp_anchors,
                rooflight_anchors=rooflight_anchors,
                note_anchors=note_anchors,
                title_regions=title_regions,
                pv_regions=pv_regions,
                pipeline_profile=pipeline_profile,
            )
        )

    if semantic_polygon is not None:
        candidates.append(
            _build_candidate(
                candidate_id="candidate_coarse_semantic_search_01",
                polygon=semantic_polygon,
                geometry_source=COARSE_GEOMETRY_SOURCE,
                geometry_confidence=0.35,
                vector_document=vector_document,
                rwp_anchors=rwp_anchors,
                rooflight_anchors=rooflight_anchors,
                note_anchors=note_anchors,
                title_regions=title_regions,
                pv_regions=pv_regions,
                pipeline_profile=pipeline_profile,
                eligible_for_auto_export=False,
                quality_warnings=[
                    "coarse_semantic_search_area",
                    "not_cad_final_geometry",
                ],
            )
        )

    if not candidates:
        candidates.append(
            _build_candidate(
                candidate_id="candidate_coarse_viewport_fallback_01",
                polygon=_drawing_viewport(vector_document),
                geometry_source=COARSE_GEOMETRY_SOURCE,
                geometry_confidence=0.20,
                vector_document=vector_document,
                rwp_anchors=rwp_anchors,
                rooflight_anchors=rooflight_anchors,
                note_anchors=note_anchors,
                title_regions=title_regions,
                pv_regions=pv_regions,
                pipeline_profile=pipeline_profile,
                eligible_for_auto_export=False,
                quality_warnings=[
                    "no_linework_candidate_generated",
                    "no_semantic_roof_scope_anchors",
                    "not_cad_final_geometry",
                ],
            )
        )

    ranked_candidates = sorted(candidates, key=lambda candidate: candidate.score, reverse=True)
    ranked_candidates = [
        candidate.model_copy(update={"rank": rank})
        for rank, candidate in enumerate(ranked_candidates, start=1)
    ]
    roof_scope_rank = next(
        (
            candidate.rank
            for candidate in ranked_candidates
            if candidate.eligible_for_auto_export
        ),
        None,
    )

    return CandidateDocument(
        document_id=vector_document.document_id,
        source_file=vector_document.source_file,
        pipeline_profile=pipeline_profile,
        candidate_regions=ranked_candidates,
        summary=CandidateSummary(
            candidate_count=len(ranked_candidates),
            top_candidate_id=ranked_candidates[0].id if ranked_candidates else None,
            top_candidate_score=ranked_candidates[0].score if ranked_candidates else None,
            roof_scope_candidate_rank=roof_scope_rank,
        ),
    )


def _build_candidate(
    *,
    candidate_id: str,
    polygon: Polygon,
    geometry_source: CandidateGeometrySource,
    geometry_confidence: float,
    vector_document: VectorDocument,
    rwp_anchors: list[Anchor],
    rooflight_anchors: list[Anchor],
    note_anchors: list[Anchor],
    title_regions: list[Polygon],
    pv_regions: list[Polygon],
    pipeline_profile: PipelineProfile,
    eligible_for_auto_export: bool | None = None,
    quality_warnings: list[str] | None = None,
) -> CandidateRegion:
    polygon = _clean_polygon(polygon)
    rooflight_count = sum(1 for anchor in rooflight_anchors if polygon.contains(anchor.point))
    rwp_count = sum(
        1
        for anchor in rwp_anchors
        if polygon.contains(anchor.point) or polygon.distance(anchor.point) <= PROXIMITY_TOLERANCE
    )
    near_notes = any(
        polygon.distance(anchor.point) <= NOTE_PROXIMITY_TOLERANCE for anchor in note_anchors
    )
    overlaps_title = any(_overlaps_meaningfully(polygon, region) for region in title_regions)
    overlaps_pv = any(_overlaps_meaningfully(polygon, region) for region in pv_regions)
    area = polygon.area

    features = CandidateFeatures(
        contains_rooflights=rooflight_count > 0,
        rooflight_count=rooflight_count,
        contains_rwp_labels=rwp_count > 0,
        rwp_label_count=rwp_count,
        near_tapered_insulation_note=near_notes,
        near_fall_arrows=near_notes,
        overlaps_title_block=overlaps_title,
        overlaps_pv_array=overlaps_pv,
        geometry_valid=polygon.is_valid and not polygon.is_empty,
        plausible_area=_is_plausible_area(area, vector_document),
    )

    vector_linework_agreement = _linework_agreement(polygon, vector_document, geometry_source)
    scores = CandidateScores(
        geometric_validity=1.0 if features.geometry_valid else 0.0,
        agreement_with_vector_linework=vector_linework_agreement,
        contains_expected_rooflights=_ratio(rooflight_count, len(rooflight_anchors)),
        contains_expected_rwp_points=_ratio(rwp_count, len(rwp_anchors)),
        proximity_to_tapered_insulation_notes=1.0 if near_notes else 0.0,
        excludes_title_block_legend_pv=0.0 if overlaps_title or overlaps_pv else 1.0,
        plausible_area_and_dimensions=1.0 if features.plausible_area else 0.0,
    )
    score = score_candidate(scores, pipeline_profile)
    if overlaps_title or overlaps_pv:
        score = round(score * 0.35, 4)
    if geometry_source == COARSE_GEOMETRY_SOURCE:
        score = round(min(score * 0.45, 0.49), 4)

    auto_export = (
        geometry_source in AUTO_EXPORT_GEOMETRY_SOURCES
        if eligible_for_auto_export is None
        else eligible_for_auto_export
    )
    warnings = [*(quality_warnings or [])]
    warnings.extend(
        _candidate_quality_warnings(features, scores, geometry_source, vector_document, area)
    )
    review_required = (
        not auto_export
        or score < 0.75
        or bool(warnings)
        or geometry_source == COARSE_GEOMETRY_SOURCE
    )

    return CandidateRegion(
        id=candidate_id,
        rank=0,
        polygon_pdf=_polygon_points(polygon),
        bbox_pdf=[round(value, 3) for value in polygon.bounds],
        area_pdf_units=round(area, 3),
        geometry_source=geometry_source,
        geometry_confidence=geometry_confidence,
        eligible_for_auto_export=auto_export,
        review_required=review_required,
        quality_warnings=sorted(set(warnings)),
        features=features,
        scores=scores,
        score=score,
    )


def _polygonized_face_candidates(vector_document: VectorDocument) -> list[Polygon]:
    viewport = _drawing_viewport(vector_document)
    title_regions = _title_regions(vector_document)
    line_segments: list[tuple[float, LineString]] = []

    for primitive in vector_document.vector_primitives:
        if primitive.type != "line" or primitive.start_pdf is None or primitive.end_pdf is None:
            continue
        if primitive.semantic_role in {
            "hatch",
            "dimension_line",
            "leader_line",
            "fall_arrow",
            "pv_array",
            "title_block",
            "legend",
            "notes",
            "rooflight",
        }:
            continue
        start = primitive.start_pdf
        end = primitive.end_pdf
        length = math.dist(start, end)
        if length < 20:
            continue
        if not _is_axis_aligned(start, end):
            continue
        segment = LineString(
            [(round(start[0], 1), round(start[1], 1)), (round(end[0], 1), round(end[1], 1))]
        )
        if not viewport.contains(segment.centroid):
            continue
        if any(segment.intersects(region) for region in title_regions):
            continue
        line_segments.append((length, segment))

    line_segments = sorted(line_segments, key=lambda item: item[0], reverse=True)[
        :MAX_POLYGONIZED_SEGMENTS
    ]
    if not line_segments:
        return []

    merged = unary_union([segment for _, segment in line_segments])
    polygons = [
        _clean_polygon(polygon)
        for polygon in polygonize(merged)
        if polygon.area >= MIN_FACE_AREA and polygon.is_valid
    ]
    unique_polygons = _dedupe_polygons(polygons)
    return sorted(unique_polygons, key=lambda polygon: polygon.area, reverse=True)[
        :MAX_POLYGONIZED_CANDIDATES
    ]


def _composite_face_candidates(
    *,
    face_polygons: list[Polygon],
    search_polygon: Polygon | None,
    rwp_anchors: list[Anchor],
    rooflight_anchors: list[Anchor],
    note_anchors: list[Anchor],
) -> list[Polygon]:
    anchors = [*rwp_anchors, *rooflight_anchors, *note_anchors]
    if not face_polygons or not anchors:
        return []

    search_area = search_polygon.buffer(COMPOSITE_ANCHOR_TOLERANCE) if search_polygon else None
    selected: list[Polygon] = []
    for polygon in face_polygons:
        if search_area is not None and not polygon.intersects(search_area):
            continue
        if any(polygon.distance(anchor.point) <= COMPOSITE_ANCHOR_TOLERANCE for anchor in anchors):
            selected.append(polygon)

    for _ in range(2):
        expanded = list(selected)
        for polygon in face_polygons:
            if polygon in expanded:
                continue
            if any(
                polygon.distance(existing) <= COMPOSITE_NEIGHBOUR_TOLERANCE
                for existing in selected
            ):
                expanded.append(polygon)
        if len(expanded) == len(selected):
            break
        selected = expanded

    candidates: list[Polygon] = []
    for cluster in _cluster_polygons(selected, COMPOSITE_NEIGHBOUR_TOLERANCE):
        merged = unary_union([polygon.buffer(3.0) for polygon in cluster]).buffer(-3.0)
        for polygon in _polygon_parts(merged):
            cleaned = _clean_polygon(polygon)
            if cleaned.area >= MIN_FACE_AREA * 2 and cleaned.is_valid:
                candidates.append(cleaned)
    return sorted(_dedupe_polygons(candidates), key=lambda polygon: polygon.area, reverse=True)[
        :MAX_COMPOSITE_CANDIDATES
    ]


def _anchor_boundary_reconstruction_candidates(
    *,
    vector_document: VectorDocument,
    seed_anchors: list[Anchor],
) -> list[ReconstructionCandidate]:
    if not seed_anchors:
        return []

    candidates: list[ReconstructionCandidate] = []
    for cluster in _cluster_anchors(seed_anchors, vector_document):
        search_polygon = _anchor_cluster_search_polygon(cluster, vector_document)
        if search_polygon.is_empty or search_polygon.area < MIN_FACE_AREA * 8:
            continue
        real_segments = _reconstruction_line_segments(vector_document, search_polygon)
        if not real_segments:
            continue
        gap_bridges = _bridge_axis_aligned_gaps(
            real_segments,
            search_polygon,
            max_gap=_bridge_tolerance(search_polygon, vector_document),
        )
        search_boundary_segments = _polygon_boundary_segments(search_polygon)
        polygonized = [
            _orthogonalized_polygon(polygon, vector_document)
            for polygon in polygonize(
                unary_union([*real_segments, *gap_bridges, *search_boundary_segments])
            )
            if polygon.area >= MIN_FACE_AREA * 8 and polygon.is_valid
        ]
        ranked = sorted(
            (
                ReconstructionCandidate(
                    polygon=polygon,
                    bridge_count=len(gap_bridges),
                    search_boundary_touch_ratio=_search_boundary_touch_ratio(
                        polygon,
                        search_polygon,
                    ),
                )
                for polygon in polygonized
                if _anchor_coverage(polygon, cluster) >= 0.55
                and _search_boundary_touch_ratio(polygon, search_polygon) <= 0.35
            ),
            key=lambda candidate: _reconstruction_rank(candidate, cluster, vector_document),
            reverse=True,
        )
        candidates.extend(ranked[:2])

    unique = _dedupe_reconstruction_candidates(candidates)
    return sorted(
        unique,
        key=lambda candidate: _reconstruction_rank(
            candidate,
            seed_anchors,
            vector_document,
        ),
        reverse=True,
    )[:MAX_RECONSTRUCTION_CANDIDATES]


def _primitive_anchors(vector_document: VectorDocument) -> list[Anchor]:
    anchors: list[Anchor] = []
    for primitive in vector_document.vector_primitives:
        if primitive.semantic_role not in {"drainage_symbol", "fall_arrow"}:
            continue
        if primitive.semantic_role == "fall_arrow" and _bbox_size(primitive.bbox_pdf) > 260:
            continue
        anchors.append(
            Anchor(
                id=f"{primitive.semantic_role}:{primitive.id}",
                point=_bbox_center(primitive.bbox_pdf),
                bbox=primitive.bbox_pdf,
            )
        )
    return anchors


def _reconstruction_seed_anchors(
    *,
    rwp_anchors: list[Anchor],
    primitive_anchors: list[Anchor],
    rooflight_anchors: list[Anchor],
) -> list[Anchor]:
    if rwp_anchors:
        return rwp_anchors
    drainage_anchors = [
        anchor for anchor in primitive_anchors if anchor.id.startswith("drainage_symbol:")
    ]
    if drainage_anchors:
        return drainage_anchors
    fall_anchors = [anchor for anchor in primitive_anchors if anchor.id.startswith("fall_arrow:")]
    if fall_anchors:
        return fall_anchors
    return rooflight_anchors


def _cluster_anchors(
    anchors: list[Anchor],
    vector_document: VectorDocument,
) -> list[list[Anchor]]:
    tolerance = _anchor_cluster_tolerance(vector_document)
    clusters: list[list[Anchor]] = []
    for anchor in anchors:
        matches = [
            index
            for index, cluster in enumerate(clusters)
            if any(anchor.point.distance(existing.point) <= tolerance for existing in cluster)
        ]
        if not matches:
            clusters.append([anchor])
            continue
        first = matches[0]
        clusters[first].append(anchor)
        for index in reversed(matches[1:]):
            clusters[first].extend(clusters.pop(index))
    return clusters


def _anchor_cluster_tolerance(vector_document: VectorDocument) -> float:
    page = vector_document.page_metadata[0]
    page_diagonal = math.hypot(page.page_width, page.page_height)
    return max(260.0, min(page_diagonal * 0.22, 720.0))


def _anchor_cluster_search_polygon(
    cluster: list[Anchor],
    vector_document: VectorDocument,
) -> Polygon:
    page = vector_document.page_metadata[0]
    x0 = min(anchor.bbox[0] for anchor in cluster)
    y0 = min(anchor.bbox[1] for anchor in cluster)
    x1 = max(anchor.bbox[2] for anchor in cluster)
    y1 = max(anchor.bbox[3] for anchor in cluster)
    width = max(x1 - x0, 1.0)
    height = max(y1 - y0, 1.0)
    page_diagonal = math.hypot(page.page_width, page.page_height)
    pad_x = max(140.0, min(max(width, height) * 0.28, page_diagonal * 0.13))
    pad_y = max(160.0, min(max(width, height) * 0.34, page_diagonal * 0.16))

    left = max(0.0, x0 - pad_x)
    top = max(0.0, y0 - pad_y)
    right = min(page.page_width, x1 + pad_x)
    bottom = min(page.page_height, y1 + pad_y)

    for region in vector_document.sheet_regions:
        if region.type != "notes":
            continue
        region_x0, region_y0, _, region_y1 = region.bbox_pdf
        if region_x0 <= x1 or not _ranges_overlap(top, bottom, region_y0, region_y1):
            continue
        right = min(right, max(left + 1.0, region_x0 - 12.0))

    return box(left, top, right, bottom)


def _reconstruction_line_segments(
    vector_document: VectorDocument,
    search_polygon: Polygon,
) -> list[LineString]:
    segments: list[LineString] = []
    for primitive in vector_document.vector_primitives:
        if primitive.type != "line" or primitive.start_pdf is None or primitive.end_pdf is None:
            continue
        if primitive.semantic_role in RECONSTRUCTION_EXCLUDED_ROLES:
            continue
        start = primitive.start_pdf
        end = primitive.end_pdf
        if math.dist(start, end) < 45 or not _is_axis_aligned(start, end):
            continue
        segment = LineString(
            [(round(start[0], 1), round(start[1], 1)), (round(end[0], 1), round(end[1], 1))]
        )
        if not search_polygon.intersects(segment):
            continue
        clipped = segment.intersection(search_polygon)
        segments.extend(_line_parts(clipped))
    return sorted(
        _dedupe_lines(segments),
        key=lambda segment: float(segment.length),
        reverse=True,
    )[:MAX_POLYGONIZED_SEGMENTS]


def _bridge_axis_aligned_gaps(
    segments: list[LineString],
    search_polygon: Polygon,
    *,
    max_gap: float,
) -> list[LineString]:
    horizontal: dict[float, list[tuple[float, float]]] = {}
    vertical: dict[float, list[tuple[float, float]]] = {}
    for segment in segments:
        coords = list(segment.coords)
        if len(coords) < 2:
            continue
        (x0, y0), (x1, y1) = coords[0], coords[-1]
        if abs(y0 - y1) <= 1.0:
            y_key = round((y0 + y1) / 2, 1)
            horizontal.setdefault(y_key, []).extend([(min(x0, x1), y_key), (max(x0, x1), y_key)])
        elif abs(x0 - x1) <= 1.0:
            x_key = round((x0 + x1) / 2, 1)
            vertical.setdefault(x_key, []).extend([(x_key, min(y0, y1)), (x_key, max(y0, y1))])

    bridges: list[LineString] = []
    seen: set[tuple[float, float, float, float]] = set()
    for y, points in horizontal.items():
        ordered = sorted({round(x, 1) for x, _ in points})
        for left, right in zip(ordered, ordered[1:], strict=False):
            gap = right - left
            if 2.0 <= gap <= max_gap:
                _append_bridge(bridges, seen, LineString([(left, y), (right, y)]), search_polygon)
    for x, points in vertical.items():
        ordered = sorted({round(y, 1) for _, y in points})
        for top, bottom in zip(ordered, ordered[1:], strict=False):
            gap = bottom - top
            if 2.0 <= gap <= max_gap:
                _append_bridge(bridges, seen, LineString([(x, top), (x, bottom)]), search_polygon)
    return bridges[:120]


def _append_bridge(
    bridges: list[LineString],
    seen: set[tuple[float, float, float, float]],
    bridge: LineString,
    search_polygon: Polygon,
) -> None:
    if not search_polygon.buffer(1.0).contains(bridge):
        return
    x0, y0 = bridge.coords[0]
    x1, y1 = bridge.coords[-1]
    key = (round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1))
    if key in seen:
        return
    seen.add(key)
    bridges.append(bridge)


def _bridge_tolerance(search_polygon: Polygon, vector_document: VectorDocument) -> float:
    page = vector_document.page_metadata[0]
    search_width = float(search_polygon.bounds[2] - search_polygon.bounds[0])
    search_height = float(search_polygon.bounds[3] - search_polygon.bounds[1])
    page_diagonal = math.hypot(page.page_width, page.page_height)
    return max(18.0, min(max(search_width, search_height) * 0.04, page_diagonal * 0.025))


def _polygon_boundary_segments(polygon: Polygon) -> list[LineString]:
    coords = list(polygon.exterior.coords)
    return [LineString([start, end]) for start, end in zip(coords, coords[1:], strict=False)]


def _anchor_coverage(polygon: Polygon, anchors: list[Anchor]) -> float:
    if not anchors:
        return 0.0
    covered = sum(
        1
        for anchor in anchors
        if polygon.contains(anchor.point) or polygon.distance(anchor.point) <= PROXIMITY_TOLERANCE
    )
    return covered / len(anchors)


def _reconstruction_rank(
    candidate: ReconstructionCandidate,
    anchors: list[Anchor],
    vector_document: VectorDocument,
) -> float:
    polygon = candidate.polygon
    coverage = _anchor_coverage(polygon, anchors)
    linework = _linework_agreement(polygon, vector_document, RECONSTRUCTION_GEOMETRY_SOURCE)
    page = vector_document.page_metadata[0]
    page_area = page.page_width * page.page_height
    broadness = min(1.0, float(polygon.area) / max(page_area * 0.35, 1.0))
    bridge_penalty = min(0.25, candidate.bridge_count * 0.002)
    boundary_penalty = min(0.35, candidate.search_boundary_touch_ratio)
    return float(
        round(
            (coverage * 0.52) + (linework * 0.30) + ((1.0 - broadness) * 0.18)
            - bridge_penalty
            - boundary_penalty,
            4,
        )
    )


def _search_boundary_touch_ratio(polygon: Polygon, search_polygon: Polygon) -> float:
    if polygon.length == 0:
        return 1.0
    return float(
        round(
            polygon.boundary.intersection(search_polygon.boundary).length / polygon.length,
            4,
        )
    )


def _orthogonalized_polygon(polygon: Polygon, vector_document: VectorDocument) -> Polygon:
    page = vector_document.page_metadata[0]
    tolerance = max(0.75, min(math.hypot(page.page_width, page.page_height) * 0.0008, 2.5))
    simplified = polygon.simplify(tolerance, preserve_topology=True)
    return _clean_polygon(simplified)


def _dedupe_reconstruction_candidates(
    candidates: list[ReconstructionCandidate],
) -> list[ReconstructionCandidate]:
    unique: list[ReconstructionCandidate] = []
    for candidate in candidates:
        if any(
            candidate.polygon.symmetric_difference(existing.polygon).area < 25
            for existing in unique
        ):
            continue
        unique.append(candidate)
    return unique


def _linework_snapped_semantic_candidate(
    vector_document: VectorDocument,
    search_polygon: Polygon,
) -> Polygon | None:
    boundary_segments: list[LineString] = []
    search_area = search_polygon.buffer(40.0)
    for primitive in vector_document.vector_primitives:
        if primitive.type != "line" or primitive.start_pdf is None or primitive.end_pdf is None:
            continue
        if primitive.semantic_role not in {"roof_perimeter", "parapet_or_wall", "unknown"}:
            continue
        start = primitive.start_pdf
        end = primitive.end_pdf
        if math.dist(start, end) < 90 or not _is_axis_aligned(start, end):
            continue
        segment = LineString(
            [(round(start[0], 1), round(start[1], 1)), (round(end[0], 1), round(end[1], 1))]
        )
        if search_area.intersects(segment):
            boundary_segments.append(segment)
    if not boundary_segments:
        return None
    polygons = [
        _clean_polygon(polygon)
        for polygon in polygonize(unary_union(boundary_segments))
        if polygon.area >= MIN_FACE_AREA * 4 and polygon.is_valid
    ]
    if not polygons:
        return None
    return max(polygons, key=lambda polygon: polygon.area)


def _semantic_envelope_candidate(
    rwp_anchors: list[Anchor],
    rooflight_anchors: list[Anchor],
    vector_document: VectorDocument,
) -> Polygon | None:
    if not rwp_anchors and not rooflight_anchors:
        return None
    bboxes = [anchor.bbox for anchor in [*rwp_anchors, *rooflight_anchors]]
    x0 = min(bbox[0] for bbox in bboxes)
    y0 = min(bbox[1] for bbox in bboxes)
    x1 = max(bbox[2] for bbox in bboxes)
    y1 = max(bbox[3] for bbox in bboxes)

    width = max(x1 - x0, 1.0)
    height = max(y1 - y0, 1.0)
    padding = max(80.0, min(max(width, height) * 0.10, 180.0))
    page = vector_document.page_metadata[0]
    return box(
        max(0.0, x0 - padding),
        max(0.0, y0 - padding),
        min(page.page_width, x1 + padding),
        min(page.page_height, y1 + padding),
    )


def _rwp_anchors(text_blocks: list[TextBlock]) -> list[Anchor]:
    anchors: list[Anchor] = []
    for block in text_blocks:
        labels = _rwp_labels_in_text(block.text)
        if not labels:
            continue
        points = _distributed_bbox_points(block.bbox_pdf, len(labels))
        for label, point in zip(labels, points, strict=True):
            anchors.append(Anchor(id=label, point=point, bbox=block.bbox_pdf))
    return anchors


def _note_anchors(text_blocks: list[TextBlock]) -> list[Anchor]:
    anchors: list[Anchor] = []
    for block in text_blocks:
        text = block.text.lower()
        has_note_keyword = any(
            token in text for token in ("tapered insulation", "fall path", "downpipe", "hopper")
        )
        if has_note_keyword:
            anchors.append(
                Anchor(id=block.id, point=_bbox_center(block.bbox_pdf), bbox=block.bbox_pdf)
            )
    return anchors


def _title_regions(vector_document: VectorDocument) -> list[Polygon]:
    regions: list[Polygon] = []
    for block in vector_document.text_blocks:
        page = vector_document.page_metadata[block.page_number - 1]
        if block.bbox_pdf[1] < page.page_height * 0.88:
            continue
        if block.text_class in {
            "drawing_title",
            "drawing_status",
            "scale_text",
            "drawing_number",
            "revision",
            "title_block_text",
        }:
            regions.append(box(*_expand_bbox(block.bbox_pdf, 8, page.page_width, page.page_height)))
    return regions


def _pv_regions(text_blocks: list[TextBlock]) -> list[Polygon]:
    return [
        box(*_expand_bbox(block.bbox_pdf, 20, 10_000, 10_000))
        for block in text_blocks
        if re.search(r"\bpv\b|photovoltaic", block.text, flags=re.IGNORECASE)
    ]


def _drawing_viewport(vector_document: VectorDocument) -> Polygon:
    viewport = next(
        (region for region in vector_document.sheet_regions if region.type == "drawing_viewport"),
        None,
    )
    if viewport is not None:
        return box(*viewport.bbox_pdf)
    page = vector_document.page_metadata[0]
    return box(0, 0, page.page_width, page.page_height)


def _rwp_labels_in_text(text: str) -> list[str]:
    return [f"rwp.{match.group(1)}" for match in re.finditer(r"\brwp\.?\s*(\d+)\b", text, re.I)]


def _bbox_center(bbox: list[float]) -> Point:
    return Point((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


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


def _is_axis_aligned(start: list[float], end: list[float]) -> bool:
    return abs(start[0] - end[0]) < 1.0 or abs(start[1] - end[1]) < 1.0


def _is_plausible_area(area: float, vector_document: VectorDocument) -> bool:
    page = vector_document.page_metadata[0]
    page_area = page.page_width * page.page_height
    return page_area * 0.001 <= area <= page_area * 0.75


def _ratio(count: int, total: int) -> float:
    if total == 0:
        return 0.0
    return round(min(1.0, count / total), 4)


def _linework_agreement(
    polygon: Polygon,
    vector_document: VectorDocument,
    geometry_source: CandidateGeometrySource,
) -> float:
    if polygon.is_empty or polygon.length == 0:
        return 0.0
    if geometry_source == COARSE_GEOMETRY_SOURCE:
        return 0.25
    if geometry_source == "vector_polygonized_face":
        return 0.95
    boundary = polygon.boundary
    boundary_length = float(boundary.length)
    matching_length = 0.0
    for primitive in vector_document.vector_primitives:
        if primitive.type != "line" or primitive.start_pdf is None or primitive.end_pdf is None:
            continue
        if primitive.semantic_role not in {"roof_perimeter", "parapet_or_wall", "unknown"}:
            continue
        segment = LineString([primitive.start_pdf, primitive.end_pdf])
        if boundary.distance(segment) <= 4.0:
            matching_length += min(float(segment.length), boundary_length)
    if boundary_length == 0:
        return 0.0
    return float(round(max(0.15, min(1.0, matching_length / boundary_length)), 4))


def _candidate_quality_warnings(
    features: CandidateFeatures,
    scores: CandidateScores,
    geometry_source: CandidateGeometrySource,
    vector_document: VectorDocument,
    area: float,
) -> list[str]:
    warnings: list[str] = []
    if geometry_source == COARSE_GEOMETRY_SOURCE:
        warnings.append("coarse_candidate_requires_review")
    if not features.geometry_valid:
        warnings.append("invalid_geometry")
    if features.overlaps_title_block:
        warnings.append("overlaps_title_block")
    if features.overlaps_pv_array:
        warnings.append("overlaps_pv_array")
    if not features.contains_rwp_labels:
        warnings.append("missing_rwp_anchor")
    if scores.agreement_with_vector_linework < 0.55:
        warnings.append("low_boundary_linework_agreement")
    page = vector_document.page_metadata[0]
    if area >= page.page_width * page.page_height * 0.35:
        warnings.append("candidate_area_too_broad")
    return warnings


def _cluster_polygons(polygons: list[Polygon], tolerance: float) -> list[list[Polygon]]:
    clusters: list[list[Polygon]] = []
    for polygon in polygons:
        matches = [
            index
            for index, cluster in enumerate(clusters)
            if any(polygon.distance(existing) <= tolerance for existing in cluster)
        ]
        if not matches:
            clusters.append([polygon])
            continue
        first = matches[0]
        clusters[first].append(polygon)
        for index in reversed(matches[1:]):
            clusters[first].extend(clusters.pop(index))
    return clusters


def _polygon_parts(geometry: object) -> list[Polygon]:
    if isinstance(geometry, Polygon):
        return [geometry]
    geoms = getattr(geometry, "geoms", [])
    return [geom for geom in geoms if isinstance(geom, Polygon)]


def _distributed_bbox_points(bbox: list[float], count: int) -> list[Point]:
    if count <= 1:
        return [_bbox_center(bbox)]
    y = (bbox[1] + bbox[3]) / 2
    step = (bbox[2] - bbox[0]) / (count + 1)
    if step <= 0:
        return [_bbox_center(bbox) for _ in range(count)]
    return [Point(bbox[0] + step * (index + 1), y) for index in range(count)]


def _line_parts(geometry: object) -> list[LineString]:
    if isinstance(geometry, LineString):
        return [geometry] if geometry.length > 0 else []
    geoms = getattr(geometry, "geoms", [])
    return [geom for geom in geoms if isinstance(geom, LineString) and geom.length > 0]


def _dedupe_lines(segments: list[LineString]) -> list[LineString]:
    unique: list[LineString] = []
    seen: set[tuple[float, float, float, float]] = set()
    for segment in segments:
        coords = list(segment.coords)
        if len(coords) < 2:
            continue
        x0, y0 = coords[0]
        x1, y1 = coords[-1]
        key = (round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1))
        reverse_key = (key[2], key[3], key[0], key[1])
        if key in seen or reverse_key in seen:
            continue
        seen.add(key)
        unique.append(segment)
    return unique


def _bbox_size(bbox: list[float]) -> float:
    return float(max(bbox[2] - bbox[0], bbox[3] - bbox[1]))


def _ranges_overlap(left_min: float, left_max: float, right_min: float, right_max: float) -> bool:
    return max(left_min, right_min) <= min(left_max, right_max)


def _overlaps_meaningfully(polygon: Polygon, region: Polygon) -> bool:
    if not polygon.intersects(region) or polygon.area == 0:
        return False
    return bool(polygon.intersection(region).area / polygon.area > 0.05)


def _clean_polygon(polygon: Polygon) -> Polygon:
    cleaned = polygon.buffer(0)
    if isinstance(cleaned, Polygon):
        return cleaned
    polygons = [geom for geom in cleaned.geoms if isinstance(geom, Polygon)]
    return max(polygons, key=lambda geom: geom.area) if polygons else Polygon()


def _polygon_points(polygon: Polygon) -> list[list[float]]:
    return [[round(x, 3), round(y, 3)] for x, y in list(polygon.exterior.coords)[:-1]]


def _dedupe_polygons(polygons: list[Polygon]) -> list[Polygon]:
    unique: list[Polygon] = []
    for polygon in polygons:
        if any(polygon.symmetric_difference(existing).area < 5 for existing in unique):
            continue
        unique.append(polygon)
    return unique
