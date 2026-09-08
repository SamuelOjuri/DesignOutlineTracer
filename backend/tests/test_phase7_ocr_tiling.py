import pytest
from PIL import Image

from app.models.raster import RasterTextBlock
from app.services.raster_pipeline.errors import RasterOcrBudgetExceeded
from app.services.raster_pipeline.ocr_tiling import OcrTile, generate_ocr_tiles
from app.services.raster_pipeline.pipeline import _offset_ocr_tile_blocks


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


def test_ocr_tile_offset_promotes_crop_coordinates_to_full_image() -> None:
    block = RasterTextBlock(
        id="ocr_001",
        text="rwp.1",
        bbox_px=[10, 20, 110, 40],
        bbox_1000=[10, 20, 110, 40],
        bbox_source="gemini_ocr_normalized",
        text_confidence=0.9,
        bbox_confidence=0.8,
        **{"class": "rwp_label"},
        class_source="gemini-3-flash-preview",
        class_confidence=0.9,
    )

    shifted = _offset_ocr_tile_blocks(
        [block],
        tile=OcrTile(id="tile_002", bbox_px=(1000, 500, 2000, 1500)),
        image_size=(3000, 2000),
    )[0]

    assert shifted.tile_id == "tile_002"
    assert shifted.bbox_px == [1010, 520, 1110, 540]
    assert shifted.bbox_1000 == [337, 260, 370, 270]
