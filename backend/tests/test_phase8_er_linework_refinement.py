from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw
from shapely.geometry import Polygon

from app.models.raster import (
    RasterRenderMetadata,
    RasterRenderResult,
    RasterSheetRegion,
    RasterTextBlock,
    SegmentationCandidate,
)
from app.services.raster_pipeline.candidates import generate_raster_candidates
from app.services.raster_pipeline.linework_refinement import refine_er_segmentation_candidates


def test_refine_er_box_uses_linework_to_emit_stepped_polygon(tmp_path: Path) -> None:
    linework_path = tmp_path / "line_enhanced.png"
    roof_polygon = [
        (100, 100),
        (700, 100),
        (700, 400),
        (500, 400),
        (500, 500),
        (260, 500),
        (260, 340),
        (100, 340),
    ]
    _write_linework(linework_path, roof_polygon)
    er_box = _er_box_candidate([100.0, 100.0, 700.0, 500.0])
    render_result = _render_result(width=900, height=700)

    refined = refine_er_segmentation_candidates(
        segmentation_candidates=[er_box],
        linework_path=linework_path,
        render_result=render_result,
        text_blocks=[_text_block("rwp_1", "rwp.1", [360, 440, 410, 470], "rwp_label")],
        sheet_regions=[_sheet_region("drawing_viewport", [0, 0, 900, 700])],
        debug_dir=tmp_path,
    )

    assert [candidate.source for candidate in refined] == [
        "gemini_er_linework_refined_region",
        "gemini_er_box_region",
    ]
    refined_candidate = refined[0]
    refined_polygon = Polygon(refined_candidate.polygon_px)
    er_box_polygon = Polygon(er_box.polygon_px)
    assert refined_polygon.is_valid
    assert refined_polygon.area < er_box_polygon.area
    assert len(refined_candidate.polygon_px) > 4
    assert refined_candidate.geometry_confidence >= er_box.geometry_confidence
    assert (tmp_path / "er_linework_crop.png").exists()
    assert (tmp_path / "er_flood_fill_mask.png").exists()
    assert (tmp_path / "er_seed_box_overlay.png").exists()
    assert (tmp_path / "er_refined_polygon_overlay.png").exists()
    audit = json.loads((tmp_path / "er_refinement_audit.json").read_text(encoding="utf-8"))
    assert audit[0]["refined"] is True


def test_refinement_falls_back_to_er_box_when_crop_has_no_linework(tmp_path: Path) -> None:
    linework_path = tmp_path / "blank_linework.png"
    Image.new("L", (900, 700), 0).save(linework_path)
    er_box = _er_box_candidate([100.0, 100.0, 700.0, 500.0])

    refined = refine_er_segmentation_candidates(
        segmentation_candidates=[er_box],
        linework_path=linework_path,
        render_result=_render_result(width=900, height=700),
        text_blocks=[],
        sheet_regions=[_sheet_region("drawing_viewport", [0, 0, 900, 700])],
        debug_dir=tmp_path,
    )

    assert refined == [er_box]
    audit = json.loads((tmp_path / "er_refinement_audit.json").read_text(encoding="utf-8"))
    assert audit[0]["refined"] is False
    assert audit[0]["reason"] == "no_linework_in_crop"


def test_refined_er_candidate_ranks_above_raw_box_candidate(tmp_path: Path) -> None:
    linework_path = tmp_path / "line_enhanced.png"
    _write_linework(
        linework_path,
        [
            (100, 100),
            (700, 100),
            (700, 400),
            (500, 400),
            (500, 500),
            (260, 500),
            (260, 340),
            (100, 340),
        ],
    )
    er_box = _er_box_candidate([100.0, 100.0, 700.0, 500.0])
    render_result = _render_result(width=900, height=700)
    segmentation_candidates = refine_er_segmentation_candidates(
        segmentation_candidates=[er_box],
        linework_path=linework_path,
        render_result=render_result,
        text_blocks=[],
        sheet_regions=[_sheet_region("drawing_viewport", [0, 0, 900, 700])],
        debug_dir=tmp_path,
    )

    document = generate_raster_candidates(
        document_id="doc",
        source_file="sample.pdf",
        render_result=render_result,
        text_blocks=[],
        primitives=[],
        segmentation_candidates=segmentation_candidates,
    )

    top_candidate = document.candidate_regions[0]
    assert top_candidate.geometry_source == "gemini_er_linework_refined_region"
    assert top_candidate.review_required is True
    assert "gemini_er_linework_refined_candidate_requires_review" in top_candidate.quality_warnings
    assert document.candidate_regions[1].geometry_source == "gemini_er_box_region"


def _write_linework(path: Path, polygon: list[tuple[int, int]]) -> None:
    image = Image.new("L", (900, 700), 0)
    draw = ImageDraw.Draw(image)
    draw.line(polygon + [polygon[0]], fill=255, width=8, joint="curve")
    image.save(path)


def _er_box_candidate(bbox_px: list[float]) -> SegmentationCandidate:
    x0, y0, x1, y1 = bbox_px
    return SegmentationCandidate(
        id="gemini_er_candidate_01",
        source="gemini_er_box_region",
        provider="gemini_er",
        prompt="segment roof",
        label="proposed flat roof / tapered insulation scope area",
        bbox_px=bbox_px,
        polygon_px=[[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
        mask_area_px=(x1 - x0) * (y1 - y0),
        geometry_confidence=0.6,
        semantic_confidence=0.65,
    )


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


def _sheet_region(region_type: str, bbox_px: list[int]) -> RasterSheetRegion:
    return RasterSheetRegion(type=region_type, bbox_px=bbox_px, confidence=0.9)


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
