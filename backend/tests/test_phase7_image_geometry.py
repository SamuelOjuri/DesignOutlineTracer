from pathlib import Path

from app.config import Settings
from app.services.raster_pipeline.image_geometry import extract_image_geometry
from app.services.raster_pipeline.preprocessing import preprocess_raster_render
from app.services.raster_pipeline.rendering import render_pdf_for_raster
from app.services.raster_pipeline.viewport import detect_raster_sheet_regions


def test_image_derived_primitives_are_tagged(
    tp17221_raster_clean_pdf: Path,
    tmp_path: Path,
) -> None:
    render = render_pdf_for_raster(
        source_path=tp17221_raster_clean_pdf,
        document_id="doc",
        settings=Settings(storage_root=tmp_path, raster_render_dpi=80),
    )
    outputs = preprocess_raster_render(Path(render.render_viewport_path), tmp_path / "debug")
    regions = detect_raster_sheet_regions(Path(render.render_viewport_path))

    primitives = extract_image_geometry(outputs["line_enhanced"], regions)

    assert primitives
    assert all(primitive.source == "image_derived" for primitive in primitives)
    assert any(primitive.type == "line" for primitive in primitives)
