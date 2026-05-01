from pathlib import Path

import pytest

from app.config import Settings
from app.services.raster_pipeline.errors import RasterRenderTooLarge
from app.services.raster_pipeline.rendering import render_pdf_for_raster


def test_raster_rendering_creates_artifacts(tp17221_raster_clean_pdf: Path, tmp_path: Path) -> None:
    settings = Settings(storage_root=tmp_path, raster_render_dpi=80, raster_preview_dpi=40)

    result = render_pdf_for_raster(
        source_path=tp17221_raster_clean_pdf,
        document_id="doc",
        settings=settings,
    )

    assert Path(result.preview_path).exists()
    assert Path(result.render_full_path).exists()
    assert Path(result.render_viewport_path).exists()
    assert result.render.source == "pymupdf"
    assert result.render.width_px > 0
    assert result.render.max_pixels_guard_applied is False


def test_raster_rendering_obeys_pixel_limit(tp17221_raster_clean_pdf: Path, tmp_path: Path) -> None:
    settings = Settings(storage_root=tmp_path, raster_render_dpi=300, raster_max_render_pixels=100)

    with pytest.raises(RasterRenderTooLarge):
        render_pdf_for_raster(
            source_path=tp17221_raster_clean_pdf,
            document_id="doc",
            settings=settings,
        )
