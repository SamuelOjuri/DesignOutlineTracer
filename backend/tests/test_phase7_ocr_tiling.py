import pytest
from PIL import Image

from app.config import Settings
from app.models.raster import OcrHints, RasterTextBlock
from app.services.raster_pipeline.errors import RasterOcrBudgetExceeded
from app.services.raster_pipeline.ocr_extraction import extract_tiled_ocr
from app.services.raster_pipeline.ocr_provider import MockOcrProvider
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


def test_adaptive_tiling_covers_large_sheet_within_budget() -> None:
    with Image.new("1", (9934, 7017)) as image:
        tiles = generate_ocr_tiles(
            image, tile_size_px=2048, overlap_px=256, max_tiles=12, adapt_to_budget=True
        )

    assert len(tiles) <= 12
    assert tiles[0].bbox_px[:2] == (0, 0)
    assert tiles[-1].bbox_px[2:] == (9934, 7017)
    row_starts = sorted({tile.bbox_px[1] for tile in tiles})
    previous_bottom = 0
    for row_start in row_starts:
        row = sorted(
            [tile for tile in tiles if tile.bbox_px[1] == row_start],
            key=lambda tile: tile.bbox_px[0],
        )
        assert row_start <= previous_bottom
        previous_right = 0
        for tile in row:
            assert tile.bbox_px[0] <= previous_right
            previous_right = tile.bbox_px[2]
        assert previous_right == 9934
        previous_bottom = row[0].bbox_px[3]
    assert previous_bottom == 7017


def test_tiled_ocr_resizes_requests_and_restores_page_coordinates() -> None:
    class RecordingProvider(MockOcrProvider):
        name = "recording"

        def extract_text_blocks(
            self, image: Image.Image, hints: OcrHints
        ) -> list[RasterTextBlock]:
            assert image.width * image.height <= 10000
            return super().extract_text_blocks(image, hints)[:1]

    settings = Settings(
        _env_file=None,
        ocr_tile_size_px=200,
        ocr_tile_overlap_px=0,
        ocr_max_tiles=2,
        raster_max_tile_pixels=10000,
    )
    hints = OcrHints(document_id="doc", source_file="roof.pdf", page_index=2, render_dpi=300)
    with Image.new("RGB", (400, 200), "white") as image:
        blocks, tiles, warnings = extract_tiled_ocr(image, RecordingProvider(), hints, settings)

    assert len(tiles) == 2
    assert blocks[0].bbox_px == [32, 130, 38, 134]
    assert blocks[1].bbox_px == [232, 130, 238, 134]
    assert blocks[1].bbox_1000 == [580, 650, 595, 670]
    assert blocks[0].id != blocks[1].id
    assert blocks[1].tile_id == "tile_002"
    assert warnings[0].code == "OCR_TILING_ADAPTED"


@pytest.mark.parametrize("tile_size, overlap, budget", [(0, 0, 12), (100, 100, 12), (100, 0, 0)])
def test_invalid_tile_settings_fail_before_iteration(
    tile_size: int, overlap: int, budget: int
) -> None:
    with Image.new("RGB", (200, 200)) as image, pytest.raises(ValueError):
        generate_ocr_tiles(
            image,
            tile_size_px=tile_size,
            overlap_px=overlap,
            max_tiles=budget,
            adapt_to_budget=True,
        )
