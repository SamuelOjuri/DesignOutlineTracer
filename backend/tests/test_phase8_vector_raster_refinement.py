"""Tests for the OpenCV/Shapely raster refinement module.

These tests build a synthetic single-page PDF that contains four straight
walls forming a rectangular roof, with a synthetic title-block region that
should be excluded from the refinement. The test asserts that the
refinement reproduces the expected boundary, rejects flooded regions that
escape into the title block, and produces a high IoU against the input
candidate when the candidate already matches the rectangle.
"""

from __future__ import annotations

from pathlib import Path

import fitz
import pytest
from shapely.geometry import Polygon, box

from app.models.vector import PageMetadata, SheetRegion
from app.services.geometry.raster_refinement import (
    MIN_REFINEMENT_IOU,
    refine_polygon_with_raster,
)


def _make_synthetic_pdf(
    output_path: Path,
    *,
    page_width: float = 600.0,
    page_height: float = 400.0,
    roof_rect: tuple[float, float, float, float] = (60.0, 60.0, 380.0, 320.0),
    title_block: tuple[float, float, float, float] = (420.0, 60.0, 580.0, 320.0),
) -> None:
    document = fitz.open()
    page = document.new_page(width=page_width, height=page_height)
    # Draw four roof walls as a rectangle outline.
    rect = fitz.Rect(*roof_rect)
    page.draw_rect(rect, color=(0, 0, 0), width=3.0)
    # Draw the title block as a filled rectangle so the floodfill cannot
    # leak into it through gaps in the roof walls.
    tb_rect = fitz.Rect(*title_block)
    page.draw_rect(tb_rect, color=(0, 0, 0), fill=(0, 0, 0), width=2.0)
    document.save(output_path)
    document.close()


@pytest.fixture()
def synthetic_pdf(tmp_path: Path) -> Path:
    pdf_path = tmp_path / "synthetic_roof.pdf"
    _make_synthetic_pdf(pdf_path)
    return pdf_path


def _page_metadata(width: float = 600.0, height: float = 400.0) -> PageMetadata:
    return PageMetadata(
        page_number=1,
        page_width=width,
        page_height=height,
        rotation=0,
        media_box=[0.0, 0.0, width, height],
        crop_box=[0.0, 0.0, width, height],
    )


def _title_block_region(
    bbox: tuple[float, float, float, float] = (420.0, 60.0, 580.0, 320.0),
) -> SheetRegion:
    return SheetRegion(
        type="title_block",
        page_number=1,
        bbox_pdf=list(bbox),
        confidence=0.95,
    )


def test_refine_polygon_with_raster_recovers_rectangle_from_anchor(
    synthetic_pdf: Path,
) -> None:
    candidate = box(60.0, 60.0, 380.0, 320.0)
    anchors = [(220.0, 190.0)]  # interior point near roof centre

    result = refine_polygon_with_raster(
        candidate_polygon=candidate,
        anchors_pdf=anchors,
        source_path=synthetic_pdf,
        page=_page_metadata(),
        sheet_regions=[_title_block_region()],
    )

    assert result is not None
    assert result.flood_seed_count == 1
    assert result.bounded_by_linework is True
    assert result.raster_iou >= MIN_REFINEMENT_IOU
    # The refined polygon should not extend into the title block region.
    title_block_polygon = box(420.0, 60.0, 580.0, 320.0)
    assert result.polygon_pdf.intersection(title_block_polygon).area < 1.0
    # The refined polygon should be approximately the size of the roof.
    expected_area = (380.0 - 60.0) * (320.0 - 60.0)
    assert result.polygon_pdf.area == pytest.approx(expected_area, rel=0.10)


def test_refine_polygon_with_raster_returns_none_without_anchors(
    synthetic_pdf: Path,
) -> None:
    candidate = box(60.0, 60.0, 380.0, 320.0)

    result = refine_polygon_with_raster(
        candidate_polygon=candidate,
        anchors_pdf=[],
        source_path=synthetic_pdf,
        page=_page_metadata(),
        sheet_regions=[_title_block_region()],
    )

    assert result is None


def test_refine_polygon_with_raster_clips_oversized_candidate(
    synthetic_pdf: Path,
) -> None:
    # Candidate over-covers the title block area; refinement should clip it
    # back to the actual roof rectangle.
    over_covered_candidate = box(60.0, 60.0, 580.0, 320.0)
    anchors = [(220.0, 190.0)]

    result = refine_polygon_with_raster(
        candidate_polygon=over_covered_candidate,
        anchors_pdf=anchors,
        source_path=synthetic_pdf,
        page=_page_metadata(),
        sheet_regions=[_title_block_region()],
    )

    assert result is not None
    refined_area = result.polygon_pdf.area
    assert refined_area < over_covered_candidate.area * 0.75
    # The refined polygon must not reach into the title block bbox.
    refined_max_x = result.polygon_pdf.bounds[2]
    assert refined_max_x <= 420.0 + 5.0


def test_refine_polygon_with_raster_skips_anchor_far_from_candidate(
    synthetic_pdf: Path,
) -> None:
    candidate = box(60.0, 60.0, 380.0, 320.0)
    # Anchor far outside the candidate polygon should be rejected.
    anchors = [(550.0, 190.0)]

    result = refine_polygon_with_raster(
        candidate_polygon=candidate,
        anchors_pdf=anchors,
        source_path=synthetic_pdf,
        page=_page_metadata(),
        sheet_regions=[_title_block_region()],
    )

    assert result is None


def test_refine_polygon_with_raster_snaps_anchor_just_outside_candidate(
    synthetic_pdf: Path,
) -> None:
    # Anchor sits just outside the candidate polygon (within snap tolerance)
    # — typical of TP17221 RWP label placement.
    candidate = box(60.0, 60.0, 380.0, 320.0)
    anchors = [(385.0, 190.0)]  # 5 PDF units outside candidate

    result = refine_polygon_with_raster(
        candidate_polygon=candidate,
        anchors_pdf=anchors,
        source_path=synthetic_pdf,
        page=_page_metadata(),
        sheet_regions=[_title_block_region()],
    )

    assert result is not None
    assert result.raster_iou > 0.5
