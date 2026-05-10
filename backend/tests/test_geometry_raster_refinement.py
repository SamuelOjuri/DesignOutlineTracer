from pathlib import Path

import fitz
import pytest
from shapely.geometry import Polygon, box

from app.models.vector import PageMetadata, SheetRegion
from app.services.geometry.raster_refinement import refine_candidate


def _write_synthetic_roof_pdf(path: Path) -> None:
    document = fitz.open()
    page = document.new_page(width=600, height=400)
    page.draw_rect(fitz.Rect(60, 60, 380, 320), color=(0, 0, 0), width=3)
    page.draw_rect(fitz.Rect(420, 60, 580, 320), color=(0, 0, 0), fill=(0, 0, 0), width=2)
    document.save(path)
    document.close()


def _write_roof_with_internal_linework_pdf(path: Path) -> None:
    document = fitz.open()
    page = document.new_page(width=600, height=400)
    page.draw_rect(fitz.Rect(60, 60, 380, 320), color=(0, 0, 0), width=3)
    page.draw_line(fitz.Point(220, 60), fitz.Point(220, 320), color=(0, 0, 0), width=3)
    page.draw_line(fitz.Point(60, 190), fitz.Point(380, 190), color=(0, 0, 0), width=1)
    document.save(path)
    document.close()


def _write_roof_with_thin_appendage_pdf(path: Path) -> Polygon:
    document = fitz.open()
    page = document.new_page(width=600, height=400)
    points = [
        (60, 120),
        (160, 120),
        (160, 112),
        (340, 112),
        (340, 120),
        (360, 120),
        (360, 320),
        (60, 320),
    ]
    for start, end in zip(points, [*points[1:], points[0]], strict=False):
        page.draw_line(fitz.Point(*start), fitz.Point(*end), color=(0, 0, 0), width=3)
    document.save(path)
    document.close()
    return Polygon(points)


@pytest.fixture()
def synthetic_roof_pdf(tmp_path: Path) -> Path:
    path = tmp_path / "synthetic_roof.pdf"
    _write_synthetic_roof_pdf(path)
    return path


def _page_metadata() -> PageMetadata:
    return PageMetadata(
        page_number=1,
        page_width=600,
        page_height=400,
        rotation=0,
        media_box=[0, 0, 600, 400],
        crop_box=[0, 0, 600, 400],
    )


def _title_block_region() -> SheetRegion:
    return SheetRegion(
        type="title_block",
        page_number=1,
        bbox_pdf=[420, 60, 580, 320],
        confidence=0.95,
    )


def test_raster_refinement_recovers_known_wall_mask_from_rwp_anchors(
    synthetic_roof_pdf: Path,
) -> None:
    result = refine_candidate(
        candidate_polygon=box(60, 60, 380, 320),
        source_path=synthetic_roof_pdf,
        page=_page_metadata(),
        anchors_pdf=[(140, 190), (300, 190)],
        sheet_regions=[_title_block_region()],
    )

    assert result is not None
    assert result.flood_seed_count == 2
    assert result.raster_iou >= 0.85
    assert result.polygon_pdf.area == pytest.approx(320 * 260, rel=0.10)


def test_raster_refinement_excludes_injected_title_block(
    synthetic_roof_pdf: Path,
) -> None:
    title_block = box(420, 60, 580, 320)

    result = refine_candidate(
        candidate_polygon=box(60, 60, 580, 320),
        source_path=synthetic_roof_pdf,
        page=_page_metadata(),
        anchors_pdf=[(140, 190), (300, 190)],
        sheet_regions=[_title_block_region()],
    )

    assert result is not None
    assert result.polygon_pdf.intersection(title_block).area < 1.0
    assert result.polygon_pdf.bounds[2] <= 425
    assert result.polygon_pdf.area < box(60, 60, 580, 320).area * 0.75


def test_raster_refinement_solidifies_internal_annotation_linework(tmp_path: Path) -> None:
    pdf_path = tmp_path / "internal_linework.pdf"
    _write_roof_with_internal_linework_pdf(pdf_path)

    result = refine_candidate(
        candidate_polygon=box(60, 60, 380, 320),
        source_path=pdf_path,
        page=_page_metadata(),
        anchors_pdf=[(140, 190)],
        sheet_regions=[],
    )

    assert result is not None
    assert result.flood_seed_count == 1
    assert result.polygon_pdf.area == pytest.approx(320 * 260, rel=0.15)


def test_raster_refinement_removes_thin_unsupported_appendage(tmp_path: Path) -> None:
    pdf_path = tmp_path / "thin_appendage.pdf"
    candidate = _write_roof_with_thin_appendage_pdf(pdf_path)

    result = refine_candidate(
        candidate_polygon=candidate,
        source_path=pdf_path,
        page=_page_metadata(),
        anchors_pdf=[(140, 220), (300, 220)],
        sheet_regions=[],
    )

    assert result is not None
    assert result.polygon_pdf.bounds[1] >= 116
    assert result.polygon_pdf.area < candidate.area * 0.99


def test_raster_refinement_rejects_missing_anchors(synthetic_roof_pdf: Path) -> None:
    result = refine_candidate(
        candidate_polygon=box(60, 60, 380, 320),
        source_path=synthetic_roof_pdf,
        page=_page_metadata(),
        anchors_pdf=[],
        sheet_regions=[_title_block_region()],
    )

    assert result is None
