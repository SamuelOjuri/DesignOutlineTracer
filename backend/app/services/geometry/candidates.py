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
MIN_FACE_AREA = 500.0
PROXIMITY_TOLERANCE = 80.0
NOTE_PROXIMITY_TOLERANCE = 350.0


@dataclass(frozen=True)
class Anchor:
    id: str
    point: Point
    bbox: list[float]


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
    title_regions = _title_regions(vector_document)
    pv_regions = _pv_regions(vector_document.text_blocks)

    candidates: list[CandidateRegion] = []
    semantic_polygon = _semantic_envelope_candidate(rwp_anchors, rooflight_anchors, vector_document)
    if semantic_polygon is not None:
        candidates.append(
            _build_candidate(
                candidate_id="candidate_semantic_roof_scope_01",
                polygon=semantic_polygon,
                geometry_source="semantic_roof_scope_envelope",
                geometry_confidence=0.70,
                vector_document=vector_document,
                rwp_anchors=rwp_anchors,
                rooflight_anchors=rooflight_anchors,
                note_anchors=note_anchors,
                title_regions=title_regions,
                pv_regions=pv_regions,
                pipeline_profile=pipeline_profile,
            )
        )

    for index, polygon in enumerate(_polygonized_face_candidates(vector_document)):
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

    ranked_candidates = sorted(candidates, key=lambda candidate: candidate.score, reverse=True)
    ranked_candidates = [
        candidate.model_copy(update={"rank": rank})
        for rank, candidate in enumerate(ranked_candidates, start=1)
    ]
    roof_scope_rank = next(
        (
            candidate.rank
            for candidate in ranked_candidates
            if candidate.geometry_source == "semantic_roof_scope_envelope"
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

    scores = CandidateScores(
        geometric_validity=1.0 if features.geometry_valid else 0.0,
        agreement_with_vector_linework=(
            0.95 if geometry_source == "vector_polygonized_face" else 0.62
        ),
        contains_expected_rooflights=_ratio(rooflight_count, len(rooflight_anchors)),
        contains_expected_rwp_points=_ratio(rwp_count, len(rwp_anchors)),
        proximity_to_tapered_insulation_notes=1.0 if near_notes else 0.0,
        excludes_title_block_legend_pv=0.0 if overlaps_title or overlaps_pv else 1.0,
        plausible_area_and_dimensions=1.0 if features.plausible_area else 0.0,
    )
    score = score_candidate(scores, pipeline_profile)
    if overlaps_title or overlaps_pv:
        score = round(score * 0.35, 4)

    return CandidateRegion(
        id=candidate_id,
        rank=0,
        polygon_pdf=_polygon_points(polygon),
        bbox_pdf=[round(value, 3) for value in polygon.bounds],
        area_pdf_units=round(area, 3),
        geometry_source=geometry_source,
        geometry_confidence=geometry_confidence,
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
        center = _bbox_center(block.bbox_pdf)
        for label in labels:
            anchors.append(Anchor(id=label, point=center, bbox=block.bbox_pdf))
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
