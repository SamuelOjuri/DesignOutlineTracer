from shapely.geometry import Polygon

from app.models.candidates import (
    CandidateBoundaryMetrics,
    CandidateDocument,
    CandidateFeatures,
    CandidateRegion,
    CandidateScores,
    CandidateSummary,
    TargetScopeIntent,
)
from app.models.raster import (
    ImageDerivedPrimitive,
    RasterRenderResult,
    RasterTextBlock,
    SegmentationCandidate,
)
from app.services.scoring.candidate_scoring import score_candidate


def generate_raster_candidates(
    *,
    document_id: str,
    source_file: str,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    primitives: list[ImageDerivedPrimitive],
    segmentation_candidates: list[SegmentationCandidate] | None = None,
) -> CandidateDocument:
    candidates: list[CandidateRegion] = []
    for index, segmentation in enumerate(segmentation_candidates or [], start=1):
        polygon = Polygon(segmentation.polygon_px).buffer(0)
        if polygon.is_empty or not isinstance(polygon, Polygon):
            continue
        candidates.append(
            _build_raster_candidate(
                candidate_id=f"raster_segmentation_{index:02d}",
                polygon=polygon,
                text_blocks=text_blocks,
                primitives=primitives,
                geometry_confidence=segmentation.geometry_confidence,
                quality_warnings=["segmentation_candidate_requires_review"],
            )
        )

    fallback_polygon = _anchor_seeded_polygon(render_result, text_blocks)
    candidates.append(
        _build_raster_candidate(
            candidate_id="raster_anchor_seeded_01",
            polygon=fallback_polygon,
            text_blocks=text_blocks,
            primitives=primitives,
            geometry_confidence=0.58,
            quality_warnings=["raster_anchor_seeded_candidate_requires_review"],
        )
    )

    ranked_candidates = sorted(candidates, key=lambda candidate: candidate.score, reverse=True)
    ranked_candidates = [
        candidate.model_copy(update={"rank": rank})
        for rank, candidate in enumerate(ranked_candidates, start=1)
    ]

    return CandidateDocument(
        document_id=document_id,
        source_file=source_file,
        pipeline_profile="raster",
        candidate_regions=ranked_candidates,
        summary=CandidateSummary(
            candidate_count=len(ranked_candidates),
            top_candidate_id=ranked_candidates[0].id if ranked_candidates else None,
            top_candidate_score=ranked_candidates[0].score if ranked_candidates else None,
            roof_scope_candidate_rank=1 if ranked_candidates else None,
        ),
        target_scope_intent=_raster_target_scope_intent(text_blocks),
    )


def _build_raster_candidate(
    *,
    candidate_id: str,
    polygon: Polygon,
    text_blocks: list[RasterTextBlock],
    primitives: list[ImageDerivedPrimitive],
    geometry_confidence: float,
    quality_warnings: list[str],
) -> CandidateRegion:
    rwp_count = sum(1 for block in text_blocks if block.text_class == "rwp_label")
    rooflight_count = sum(1 for block in text_blocks if block.text_class == "rooflight_label")
    positive_anchor_count = sum(
        1
        for block in text_blocks
        if block.text_class in {"rwp_label", "rooflight_label", "fall_path_note"}
    )
    anchor_coverage = 1.0 if positive_anchor_count else 0.0
    boundary_quality = 0.52 if primitives else 0.28
    boundary_metrics = CandidateBoundaryMetrics(
        boundary_supported_ratio=boundary_quality,
        included_positive_anchor_ratio=anchor_coverage,
        internal_constraint_coverage=1.0 if rooflight_count else 0.0,
        scope_fragment_risk=0.0 if positive_anchor_count else 0.8,
        linework_closure_confidence=boundary_quality,
    )
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
        positive_anchor_count=positive_anchor_count,
        positive_anchor_coverage=anchor_coverage,
        geometry_valid=polygon.is_valid,
        plausible_area=True,
    )
    scores = CandidateScores(
        geometric_validity=1.0 if polygon.is_valid else 0.0,
        agreement_with_vector_linework=boundary_quality,
        contains_expected_rooflights=1.0 if rooflight_count else 0.0,
        contains_expected_rwp_points=min(1.0, rwp_count / 5),
        proximity_to_tapered_insulation_notes=1.0 if features.near_tapered_insulation_note else 0.0,
        excludes_title_block_legend_pv=1.0,
        plausible_area_and_dimensions=1.0,
        boundary_evidence_quality=boundary_metrics.linework_closure_confidence,
        semantic_scope_alignment=anchor_coverage,
        excludes_detected_exclusions=1.0,
    )
    return CandidateRegion(
        id=candidate_id,
        rank=1,
        polygon_pdf=[[round(x, 3), round(y, 3)] for x, y in polygon.exterior.coords[:-1]],
        bbox_pdf=[round(value, 3) for value in polygon.bounds],
        area_pdf_units=round(polygon.area, 3),
        geometry_source="raster_contour_polygonisation",
        geometry_confidence=geometry_confidence,
        eligible_for_auto_export=False,
        review_required=True,
        quality_warnings=quality_warnings,
        features=features,
        scores=scores,
        boundary_metrics=boundary_metrics,
        score=score_candidate(scores, "raster"),
    )


def _raster_target_scope_intent(text_blocks: list[RasterTextBlock]) -> TargetScopeIntent:
    include_evidence = sorted(
        {
            block.text_class
            for block in text_blocks
            if block.text_class
            in {"rwp_label", "rooflight_label", "fall_path_note", "roof_build_up_note"}
        }
    )
    return TargetScopeIntent(
        include_evidence=include_evidence or ["raster_visual_scope"],
        exclude_evidence=["title_block", "legend", "notes", "pv_array"],
        allow_multiple_regions=False,
        requires_review_if_ambiguous=True,
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
