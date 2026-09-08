import json
from pathlib import Path

import pytest

from app.config import Settings
from app.models.raster import (
    RasterRenderMetadata,
    RasterRenderResult,
    RasterTextBlock,
    SegmentationCandidate,
)
from app.services.raster_pipeline.candidates import generate_raster_candidates
from app.services.raster_pipeline.pipeline import run_raster_pipeline


def test_raster_pipeline_produces_review_required_candidate(
    tp17221_raster_clean_pdf: Path,
    tmp_path: Path,
) -> None:
    result = run_raster_pipeline(
        source_path=tp17221_raster_clean_pdf,
        document_id="doc",
        settings=Settings(
            storage_root=tmp_path,
            raster_render_dpi=80,
            raster_ocr_provider="mock",
            segmentation_provider="noop",
            allow_live_ai_calls=False,
            google_api_key=None,
        ),
    )

    schema = result.production_schema
    assert result.human_review_status == "required"
    assert result.raster_audit.candidate_count >= 1
    assert schema.quality_checks.human_review_status == "required"
    assert schema.target_area.review_required is True
    assert schema.target_area.geometry_source == "raster_contour_polygonisation"
    assert result.image_derived_primitives


def test_raster_pipeline_completes_with_gemini_ocr_and_gemini_er(
    tp17221_raster_clean_pdf: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ocr_builder_calls: list[dict[str, object]] = []
    er_builder_calls: list[dict[str, object]] = []

    def fake_ocr_builder(**kwargs: object):
        ocr_builder_calls.append(kwargs)

        def fake_ocr_call(image: object, prompt: str) -> str:
            return json.dumps(
                {
                    "text_blocks": [
                        {
                            "text": "rwp.1",
                            "bbox_1000": [160, 650, 190, 670],
                            "class": "rwp_label",
                            "confidence": 0.9,
                        },
                        {
                            "text": "rwp.2",
                            "bbox_1000": [240, 790, 280, 810],
                            "class": "rwp_label",
                            "confidence": 0.9,
                        },
                        {
                            "text": "Proprietary roof light",
                            "bbox_1000": [780, 650, 860, 700],
                            "class": "rooflight_label",
                            "confidence": 0.9,
                        },
                        {
                            "text": "1:50",
                            "bbox_1000": [720, 930, 750, 950],
                            "class": "scale_text",
                            "confidence": 0.9,
                        },
                    ]
                }
            )

        return fake_ocr_call

    def fake_er_builder(**kwargs: object):
        er_builder_calls.append(kwargs)

        def fake_er_call(image: object, prompt: str) -> str:
            return json.dumps(
                [
                    {
                        "point": [650, 300],
                        "label": "proposed flat roof area requiring tapered insulation",
                    }
                ]
            )

        return fake_er_call

    monkeypatch.setattr(
        "app.services.raster_pipeline.ocr_provider.build_gemini_image_prompt_model_call",
        fake_ocr_builder,
    )
    monkeypatch.setattr(
        "app.services.raster_pipeline.pipeline.build_gemini_er_model_call",
        fake_er_builder,
    )

    result = run_raster_pipeline(
        source_path=tp17221_raster_clean_pdf,
        document_id="doc",
        settings=Settings(
            storage_root=tmp_path,
            raster_render_dpi=80,
            raster_ocr_provider="gemini",
            segmentation_provider="gemini_er",
            allow_live_ai_calls=True,
            google_api_key="test-key",
        ),
    )

    assert result.ocr_audit.provider == "gemini"
    assert result.ocr_audit.model == "gemini-3-flash-preview"
    assert result.ocr_audit.live_calls >= 1
    assert result.segmentation_audit.provider == "gemini_er"
    assert result.segmentation_audit.live_calls == 1
    assert result.production_schema.quality_checks.human_review_status == "required"
    assert any(block.text_class == "rwp_label" for block in result.text_blocks)
    assert ocr_builder_calls[0]["model_name"] == "gemini-3-flash-preview"
    assert er_builder_calls[0]["model_name"] == "gemini-robotics-er-1.6-preview"


def test_gemini_er_point_anchor_seeds_local_raster_candidate() -> None:
    render_result = _render_result(width=1000, height=800)
    text_blocks = [
        _text_block("rwp_1", "rwp.1", [210, 500, 250, 530], "rwp_label"),
        _text_block("rwp_2", "rwp.2", [340, 540, 380, 570], "rwp_label"),
        _text_block(
            "far_note",
            "Fall paths to be designed by tapered insulation manufacturer",
            [850, 500, 970, 560],
            "fall_path_note",
        ),
    ]
    point_anchor = SegmentationCandidate(
        id="gemini_er_point_anchor_01",
        type="point_anchor",
        source="gemini_er_point_anchor",
        provider="gemini_er",
        prompt="segment roof",
        label="proposed flat roof area requiring tapered insulation",
        point_norm=[650, 300],
        point_px=[300.0, 520.0],
        bbox_px=[285.0, 505.0, 315.0, 535.0],
        polygon_px=[[285.0, 505.0], [315.0, 505.0], [315.0, 535.0], [285.0, 535.0]],
        mask_area_px=900.0,
        geometry_confidence=0.35,
        semantic_confidence=0.72,
    )

    document = generate_raster_candidates(
        document_id="doc",
        source_file="sample.pdf",
        render_result=render_result,
        text_blocks=text_blocks,
        primitives=[],
        segmentation_candidates=[point_anchor],
    )

    top_candidate = document.candidate_regions[0]
    fallback_candidate = document.candidate_regions[1]
    assert top_candidate.geometry_source == "gemini_er_point_seeded_region"
    assert top_candidate.review_required is True
    assert top_candidate.eligible_for_auto_export is False
    assert "gemini_er_point_seeded_candidate_requires_review" in top_candidate.quality_warnings
    assert top_candidate.features.rwp_label_count == 2
    assert top_candidate.bbox_pdf[2] < 700
    assert fallback_candidate.geometry_source == "coarse_semantic_search_area"


def _render_result(*, width: int, height: int) -> RasterRenderResult:
    return RasterRenderResult(
        render=RasterRenderMetadata(
            page_index=0,
            preview_dpi=80,
            render_dpi=80,
            width_px=width,
            height_px=height,
            render_scope="drawing_viewport",
            max_pixels_guard_applied=False,
        ),
        preview_path="preview.png",
        render_full_path="full.png",
        render_viewport_path="viewport.png",
        viewport_bbox_px=[0, 0, width, height],
    )


def _text_block(
    block_id: str,
    text: str,
    bbox_px: list[int],
    text_class: str,
) -> RasterTextBlock:
    return RasterTextBlock(
        id=block_id,
        text=text,
        bbox_px=bbox_px,
        bbox_1000=[0, 0, 0, 0],
        bbox_source="test",
        text_confidence=0.9,
        bbox_confidence=0.9,
        **{"class": text_class},
        class_source="test",
        class_confidence=0.9,
    )
