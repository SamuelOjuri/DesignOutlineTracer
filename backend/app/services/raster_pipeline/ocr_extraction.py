import math

from PIL import Image

from app.config import Settings
from app.models.raster import OcrHints, RasterTextBlock, RasterWarning
from app.services.raster_pipeline.ocr_provider import OcrProvider
from app.services.raster_pipeline.ocr_tiling import OcrTile, generate_ocr_tiles


def extract_tiled_ocr(
    image: Image.Image,
    provider: OcrProvider,
    hints: OcrHints,
    settings: Settings,
) -> tuple[list[RasterTextBlock], list[OcrTile], list[RasterWarning]]:
    if settings.raster_max_tile_pixels <= 0:
        raise ValueError("RASTER_MAX_TILE_PIXELS must be positive")
    tiles = generate_ocr_tiles(
        image,
        tile_size_px=settings.ocr_tile_size_px,
        overlap_px=settings.ocr_tile_overlap_px,
        max_tiles=settings.ocr_max_tiles,
        adapt_to_budget=True,
    )
    blocks: list[RasterTextBlock] = []
    adapted = False
    resized = False
    for tile in tiles:
        left, top, right, bottom = tile.bbox_px
        width, height = right - left, bottom - top
        adapted |= max(width, height) > settings.ocr_tile_size_px
        with image.crop(tile.bbox_px) as crop:
            if crop.width * crop.height > settings.raster_max_tile_pixels:
                ratio = math.sqrt(settings.raster_max_tile_pixels / (crop.width * crop.height))
                crop.thumbnail(
                    (max(1, int(crop.width * ratio)), max(1, int(crop.height * ratio))),
                    Image.Resampling.LANCZOS,
                )
                resized = True
            detections = provider.extract_text_blocks(crop, hints)
            for index, block in enumerate(detections, start=1):
                box = [
                    left + round(block.bbox_px[0] * width / crop.width),
                    top + round(block.bbox_px[1] * height / crop.height),
                    left + round(block.bbox_px[2] * width / crop.width),
                    top + round(block.bbox_px[3] * height / crop.height),
                ]
                blocks.append(
                    block.model_copy(
                        update={
                            "id": f"page_{hints.page_index}_{tile.id}_{index:04d}",
                            "tile_id": tile.id,
                            "bbox_px": box,
                            "bbox_1000": [
                                round(box[0] * 1000 / image.width),
                                round(box[1] * 1000 / image.height),
                                round(box[2] * 1000 / image.width),
                                round(box[3] * 1000 / image.height),
                            ],
                        }
                    )
                )
    warnings = []
    if adapted or resized:
        warnings.append(
            RasterWarning(
                code="OCR_TILING_ADAPTED",
                message=(
                    f"OCR used {len(tiles)} tiles within the {settings.ocr_max_tiles}-tile budget. "
                    "Source tiles were enlarged or resized to respect request limits; "
                    "check small text during review."
                ),
            )
        )
    return blocks, tiles, warnings
