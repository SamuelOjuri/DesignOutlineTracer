import pytest
from PIL import Image

from app.services.raster_pipeline.errors import RasterOcrBudgetExceeded
from app.services.raster_pipeline.ocr_tiling import generate_ocr_tiles


def test_ocr_tiling_recomposes_full_image_coordinates() -> None:
    image = Image.new("RGB", (3000, 1800), "white")

    tiles = generate_ocr_tiles(image, tile_size_px=1200, overlap_px=200, max_tiles=12)

    assert tiles[0].bbox_px == (0, 0, 1200, 1200)
    assert tiles[-1].bbox_px[2:] == (3000, 1800)
    assert len(tiles) <= 12


def test_ocr_tiling_budget_exceeded() -> None:
    image = Image.new("RGB", (5000, 5000), "white")

    with pytest.raises(RasterOcrBudgetExceeded):
        generate_ocr_tiles(image, tile_size_px=1000, overlap_px=100, max_tiles=2)
