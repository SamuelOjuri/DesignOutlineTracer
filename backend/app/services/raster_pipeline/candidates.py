from shapely.geometry import Polygon, box

from app.models.candidates import (
    CandidateDocument,
    CandidateFeatures,
    CandidateGeometrySource,
    CandidateRegion,
    CandidateScores,
    CandidateSummary,
)
from app.models.raster import (
    ImageDerivedPrimitive,
    RasterRenderResult,
    RasterTextBlock,
    SegmentationCandidate,
)
from app.services.scoring.candidate_scoring import score_candidate

BOX_GEOMETRY_SOURCE: CandidateGeometrySource = "gemini_er_box_region"
MASK_GEOMETRY_SOURCE: CandidateGeometrySource = "gemini_er_mask_region"
POINT_SEEDED_GEOMETRY_SOURCE: CandidateGeometrySource = "gemini_er_point_seeded_region"
REFINED_GEOMETRY_SOURCE: CandidateGeometrySource = "gemini_er_linework_refined_region"
COARSE_GEOMETRY_SOURCE: CandidateGeometrySource = "coarse_semantic_search_area"
POINT_SUPPORT_TEXT_CLASSES = {
    "rwp_label",
    "rooflight_label",
    "fall_path_note",
    "roof_build_up_note",
}


def generate_raster_candidates(
    *,
    document_id: str,
    source_file: str,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    primitives: list[ImageDerivedPrimitive],
    segmentation_candidates: list[SegmentationCandidate] | None = None,
) -> CandidateDocument:
    segmentation_candidates = segmentation_candidates or []
    candidate_regions: list[CandidateRegion] = []
    for index, segmentation_candidate in enumerate(segmentation_candidates, start=1):
        candidate = _candidate_from_segmentation(
            index=index,
            segmentation_candidate=segmentation_candidate,
            render_result=render_result,
            text_blocks=text_blocks,
            primitives=primitives,
        )
        if candidate is not None:
            candidate_regions.append(candidate)

    candidate_regions.append(
        _coarse_candidate(
            render_result=render_result,
            text_blocks=text_blocks,
            primitives=primitives,
            score_cap=0.64 if candidate_regions else None,
        )
    )
    candidate_regions = _rank_candidates(candidate_regions)
    for rank, candidate in enumerate(candidate_regions, start=1):
        candidate.rank = rank

    return CandidateDocument(
        document_id=document_id,
        source_file=source_file,
        pipeline_profile="raster",
        candidate_regions=candidate_regions,
        summary=CandidateSummary(
            candidate_count=len(candidate_regions),
            top_candidate_id=candidate_regions[0].id,
            top_candidate_score=candidate_regions[0].score,
            roof_scope_candidate_rank=1,
        ),
    )


def _coarse_candidate(
    *,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    primitives: list[ImageDerivedPrimitive],
    score_cap: float | None = None,
) -> CandidateRegion:
    polygon = _anchor_seeded_polygon(render_result, text_blocks)
    rwp_count = sum(1 for block in text_blocks if block.text_class == "rwp_label")
    rooflight_count = sum(1 for block in text_blocks if block.text_class == "rooflight_label")
    features = CandidateFeatures(
        contains_rooflights=rooflight_count > 0,
        rooflight_count=rooflight_count,
        contains_rwp_labels=rwp_count > 0,
        rwp_label_count=rwp_count,
        near_tapered_insulation_note=any(
            block.text_class == "fall_path_note" for block in text_blocks
        ),
        near_fall_arrows=any(block.text_class == "fall_path_note" for block in text_blocks),
        overlaps_title_block=False,
        overlaps_pv_array=False,
        geometry_valid=polygon.is_valid,
        plausible_area=True,
    )
    scores = CandidateScores(
        geometric_validity=1.0 if polygon.is_valid else 0.0,
        agreement_with_vector_linework=0.45 if primitives else 0.2,
        contains_expected_rooflights=1.0 if rooflight_count else 0.0,
        contains_expected_rwp_points=min(1.0, rwp_count / 5),
        proximity_to_tapered_insulation_notes=1.0 if features.near_tapered_insulation_note else 0.0,
        excludes_title_block_legend_pv=1.0,
        plausible_area_and_dimensions=1.0,
    )
    score = score_candidate(scores, "raster")
    if score_cap is not None:
        score = min(score, score_cap)
    return CandidateRegion(
        id="raster_candidate_01",
        rank=1,
        polygon_pdf=[[round(x, 3), round(y, 3)] for x, y in polygon.exterior.coords[:-1]],
        bbox_pdf=[round(value, 3) for value in polygon.bounds],
        area_pdf_units=round(polygon.area, 3),
        geometry_source=COARSE_GEOMETRY_SOURCE,
        geometry_confidence=0.58,
        eligible_for_auto_export=False,
        review_required=True,
        quality_warnings=["raster_anchor_seeded_candidate_requires_review"],
        features=features,
        scores=scores,
        score=score,
    )


def _candidate_from_segmentation(
    *,
    index: int,
    segmentation_candidate: SegmentationCandidate,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    primitives: list[ImageDerivedPrimitive],
) -> CandidateRegion | None:
    if segmentation_candidate.source == "gemini_er_point_anchor":
        polygon = _point_seeded_polygon(
            render_result=render_result,
            text_blocks=text_blocks,
            segmentation_candidate=segmentation_candidate,
        )
        geometry_source = POINT_SEEDED_GEOMETRY_SOURCE
        candidate_id = f"raster_gemini_er_point_seeded_{index:02d}"
        geometry_confidence = max(0.4, segmentation_candidate.geometry_confidence)
        quality_warning = "gemini_er_point_seeded_candidate_requires_review"
    elif segmentation_candidate.source == "gemini_er_linework_refined_region":
        polygon = _polygon_from_segmentation_candidate(segmentation_candidate)
        geometry_source = REFINED_GEOMETRY_SOURCE
        candidate_id = f"raster_gemini_er_linework_refined_{index:02d}"
        geometry_confidence = max(0.55, segmentation_candidate.geometry_confidence)
        quality_warning = "gemini_er_linework_refined_candidate_requires_review"
    else:
        polygon = _polygon_from_segmentation_candidate(segmentation_candidate)
        geometry_source = _geometry_source_from_segmentation(segmentation_candidate)
        candidate_id = f"raster_segmentation_candidate_{index:02d}"
        geometry_confidence = segmentation_candidate.geometry_confidence
        quality_warning = _quality_warning_from_segmentation(segmentation_candidate)

    if polygon is None or polygon.is_empty or polygon.area <= 0:
        return None
    if not polygon.is_valid:
        repaired = polygon.buffer(0)
        if not isinstance(repaired, Polygon) or repaired.is_empty:
            return None
        polygon = repaired

    features = _features_for_polygon(
        polygon=polygon,
        text_blocks=text_blocks,
        semantic_seed=segmentation_candidate.provider == "gemini_er",
    )
    scores = _scores_for_features(
        features=features,
        primitives=primitives,
        geometry_confidence=geometry_confidence,
    )
    semantic_confidence = segmentation_candidate.semantic_confidence or 0.0
    score = max(score_candidate(scores, "raster"), min(0.88, semantic_confidence + 0.08))
    return CandidateRegion(
        id=candidate_id,
        rank=index,
        polygon_pdf=[[round(x, 3), round(y, 3)] for x, y in polygon.exterior.coords[:-1]],
        bbox_pdf=[round(value, 3) for value in polygon.bounds],
        area_pdf_units=round(polygon.area, 3),
        geometry_source=geometry_source,
        geometry_confidence=round(geometry_confidence, 3),
        eligible_for_auto_export=False,
        review_required=True,
        quality_warnings=[quality_warning],
        features=features,
        scores=scores,
        score=round(score, 4),
    )


def _polygon_from_segmentation_candidate(
    segmentation_candidate: SegmentationCandidate,
) -> Polygon | None:
    if len(segmentation_candidate.polygon_px) < 3:
        return None
    return Polygon((point[0], point[1]) for point in segmentation_candidate.polygon_px)


def _geometry_source_from_segmentation(
    segmentation_candidate: SegmentationCandidate,
) -> CandidateGeometrySource:
    if segmentation_candidate.provider != "gemini_er":
        return "raster_contour_polygonisation"
    if segmentation_candidate.source == "gemini_er_mask_region":
        return MASK_GEOMETRY_SOURCE
    if segmentation_candidate.source == "gemini_er_box_region":
        return BOX_GEOMETRY_SOURCE
    if segmentation_candidate.source == "gemini_er_candidate_mask":
        return MASK_GEOMETRY_SOURCE
    return BOX_GEOMETRY_SOURCE


def _quality_warning_from_segmentation(
    segmentation_candidate: SegmentationCandidate,
) -> str:
    if segmentation_candidate.source == "gemini_er_mask_region":
        return "gemini_er_mask_candidate_requires_review"
    if segmentation_candidate.source == "gemini_er_box_region":
        return "gemini_er_box_candidate_requires_linework_review"
    if segmentation_candidate.provider == "gemini_er":
        return "gemini_er_segmentation_candidate_requires_review"
    return "raster_segmentation_candidate_requires_review"


def _point_seeded_polygon(
    *,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    segmentation_candidate: SegmentationCandidate,
) -> Polygon | None:
    if segmentation_candidate.point_px is None:
        return _polygon_from_segmentation_candidate(segmentation_candidate)

    seed_x, seed_y = segmentation_candidate.point_px
    support_blocks = _point_support_blocks(
        point_px=segmentation_candidate.point_px,
        render_result=render_result,
        text_blocks=text_blocks,
    )
    anchors = [block.bbox_px for block in support_blocks]
    anchors.append([int(seed_x), int(seed_y), int(seed_x), int(seed_y)])

    x0 = min(bbox[0] for bbox in anchors)
    y0 = min(bbox[1] for bbox in anchors)
    x1 = max(bbox[2] for bbox in anchors)
    y1 = max(bbox[3] for bbox in anchors)
    viewport_x0, viewport_y0, viewport_x1, viewport_y1 = render_result.viewport_bbox_px
    pad = max(160, int(max(x1 - x0, y1 - y0) * 0.22))
    return Polygon(
        [
            (max(viewport_x0, x0 - pad), max(viewport_y0, y0 - pad)),
            (min(viewport_x1, x1 + pad), max(viewport_y0, y0 - pad)),
            (min(viewport_x1, x1 + pad), min(viewport_y1, y1 + pad)),
            (max(viewport_x0, x0 - pad), min(viewport_y1, y1 + pad)),
        ]
    )


def _point_support_blocks(
    *,
    point_px: list[float],
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
) -> list[RasterTextBlock]:
    viewport_x0, viewport_y0, viewport_x1, viewport_y1 = render_result.viewport_bbox_px
    radius = max(350.0, min(viewport_x1 - viewport_x0, viewport_y1 - viewport_y0) * 0.5)
    support_blocks: list[RasterTextBlock] = []
    for block in text_blocks:
        if block.text_class not in POINT_SUPPORT_TEXT_CLASSES:
            continue
        center_x = (block.bbox_px[0] + block.bbox_px[2]) / 2
        center_y = (block.bbox_px[1] + block.bbox_px[3]) / 2
        distance = ((center_x - point_px[0]) ** 2 + (center_y - point_px[1]) ** 2) ** 0.5
        if distance <= radius:
            support_blocks.append(block)
    return support_blocks


def _features_for_polygon(
    *,
    polygon: Polygon,
    text_blocks: list[RasterTextBlock],
    semantic_seed: bool = False,
) -> CandidateFeatures:
    blocks_in_polygon = [
        block for block in text_blocks if _block_intersects_polygon(block, polygon)
    ]
    rwp_count = sum(1 for block in blocks_in_polygon if block.text_class == "rwp_label")
    rooflight_count = sum(1 for block in blocks_in_polygon if block.text_class == "rooflight_label")
    near_tapered_note = semantic_seed or any(
        block.text_class in {"fall_path_note", "roof_build_up_note"}
        for block in blocks_in_polygon
    )
    return CandidateFeatures(
        contains_rooflights=rooflight_count > 0,
        rooflight_count=rooflight_count,
        contains_rwp_labels=rwp_count > 0,
        rwp_label_count=rwp_count,
        near_tapered_insulation_note=near_tapered_note,
        near_fall_arrows=any(block.text_class == "fall_path_note" for block in blocks_in_polygon),
        overlaps_title_block=False,
        overlaps_pv_array=False,
        geometry_valid=polygon.is_valid,
        plausible_area=polygon.area > 0,
    )


def _block_intersects_polygon(block: RasterTextBlock, polygon: Polygon) -> bool:
    return polygon.intersects(box(*block.bbox_px))


def _scores_for_features(
    *,
    features: CandidateFeatures,
    primitives: list[ImageDerivedPrimitive],
    geometry_confidence: float,
) -> CandidateScores:
    return CandidateScores(
        geometric_validity=min(1.0, max(0.0, geometry_confidence + 0.2))
        if features.geometry_valid
        else 0.0,
        agreement_with_vector_linework=0.5 if primitives else 0.25,
        contains_expected_rooflights=1.0 if features.contains_rooflights else 0.0,
        contains_expected_rwp_points=min(1.0, features.rwp_label_count / 5),
        proximity_to_tapered_insulation_notes=1.0
        if features.near_tapered_insulation_note
        else 0.0,
        excludes_title_block_legend_pv=1.0,
        plausible_area_and_dimensions=1.0 if features.plausible_area else 0.0,
    )


def _rank_candidates(candidates: list[CandidateRegion]) -> list[CandidateRegion]:
    priority = {
        REFINED_GEOMETRY_SOURCE: 0,
        MASK_GEOMETRY_SOURCE: 1,
        BOX_GEOMETRY_SOURCE: 2,
        POINT_SEEDED_GEOMETRY_SOURCE: 3,
        COARSE_GEOMETRY_SOURCE: 4,
    }
    return sorted(
        candidates,
        key=lambda candidate: (priority.get(candidate.geometry_source, 1), -candidate.score),
    )


def _anchor_seeded_polygon(
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
) -> Polygon:
    anchors = [
        block.bbox_px
        for block in text_blocks
        if block.text_class in {"rwp_label", "rooflight_label", "fall_path_note"}
    ]
    if anchors:
        x0 = min(bbox[0] for bbox in anchors)
        y0 = min(bbox[1] for bbox in anchors)
        x1 = max(bbox[2] for bbox in anchors)
        y1 = max(bbox[3] for bbox in anchors)
    else:
        x0, y0, x1, y1 = render_result.viewport_bbox_px
    width = render_result.render.width_px
    height = render_result.render.height_px
    pad = max(80, int(max(x1 - x0, y1 - y0) * 0.18))
    return Polygon(
        [
            (max(0, x0 - pad), max(0, y0 - pad)),
            (min(width, x1 + pad), max(0, y0 - pad)),
            (min(width, x1 + pad), min(height, y1 + pad)),
            (max(0, x0 - pad), min(height, y1 + pad)),
        ]
    )
