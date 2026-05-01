from pathlib import Path

from app.config import Settings
from app.services.raster_pipeline.rendering import render_pdf_for_raster
from app.services.raster_pipeline.viewport import detect_raster_sheet_regions


def test_viewport_detection_excludes_title_block(
    tp17221_raster_clean_pdf: Path,
    tmp_path: Path,
) -> None:
    render = render_pdf_for_raster(
        source_path=tp17221_raster_clean_pdf,
        document_id="doc",
        settings=Settings(storage_root=tmp_path, raster_render_dpi=80),
    )
    regions = detect_raster_sheet_regions(Path(render.render_viewport_path))
    viewport = next(region for region in regions if region.type == "drawing_viewport")
    title_block = next(region for region in regions if region.type == "title_block")

    assert viewport.bbox_px[2] < title_block.bbox_px[2]
    assert title_block.bbox_px[0] > viewport.bbox_px[0]
    assert {region.type for region in regions} >= {"legend", "notes", "revision_table"}
