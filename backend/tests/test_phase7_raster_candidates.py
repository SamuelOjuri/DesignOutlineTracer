from pathlib import Path

from app.config import Settings
from app.services.raster_pipeline.pipeline import run_raster_pipeline


def test_raster_pipeline_produces_review_required_candidate(
    tp17221_raster_clean_pdf: Path,
    tmp_path: Path,
) -> None:
    result = run_raster_pipeline(
        source_path=tp17221_raster_clean_pdf,
        document_id="doc",
        settings=Settings(storage_root=tmp_path, raster_render_dpi=80, raster_ocr_provider="mock"),
    )

    schema = result.production_schema
    assert result.human_review_status == "required"
    assert result.raster_audit.candidate_count >= 1
    assert schema.quality_checks.human_review_status == "required"
    assert schema.target_area.review_required is True
    assert schema.target_area.geometry_source == "raster_contour_polygonisation"
    assert result.image_derived_primitives
