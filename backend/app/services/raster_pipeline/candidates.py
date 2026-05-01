from shapely.geometry import Polygon

from app.models.candidates import (
    CandidateDocument,
    CandidateFeatures,
    CandidateRegion,
    CandidateScores,
    CandidateSummary,
)
from app.models.raster import ImageDerivedPrimitive, RasterRenderResult, RasterTextBlock
from app.services.scoring.candidate_scoring import score_candidate


def generate_raster_candidates(
    *,
    document_id: str,
    source_file: str,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    primitives: list[ImageDerivedPrimitive],
) -> CandidateDocument:
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
    candidate = CandidateRegion(
        id="raster_candidate_01",
        rank=1,
        polygon_pdf=[[round(x, 3), round(y, 3)] for x, y in polygon.exterior.coords[:-1]],
        bbox_pdf=[round(value, 3) for value in polygon.bounds],
        area_pdf_units=round(polygon.area, 3),
        geometry_source="semantic_roof_scope_envelope",
        geometry_confidence=0.58,
        features=features,
        scores=scores,
        score=score_candidate(scores, "raster"),
    )
    return CandidateDocument(
        document_id=document_id,
        source_file=source_file,
        pipeline_profile="raster",
        candidate_regions=[candidate],
        summary=CandidateSummary(
            candidate_count=1,
            top_candidate_id=candidate.id,
            top_candidate_score=candidate.score,
            roof_scope_candidate_rank=1,
        ),
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
