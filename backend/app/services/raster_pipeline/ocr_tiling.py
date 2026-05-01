from dataclasses import dataclass

from PIL import Image

from app.services.raster_pipeline.errors import RasterOcrBudgetExceeded


@dataclass(frozen=True)
class OcrTile:
    id: str
    bbox_px: tuple[int, int, int, int]


def generate_ocr_tiles(
    image: Image.Image,
    *,
    tile_size_px: int,
    overlap_px: int,
    max_tiles: int,
) -> list[OcrTile]:
    width, height = image.size
    if width <= tile_size_px and height <= tile_size_px:
        return [OcrTile(id="tile_001", bbox_px=(0, 0, width, height))]

    stride = max(1, tile_size_px - overlap_px)
    tiles: list[OcrTile] = []
    y = 0
    while y < height:
        x = 0
        y1 = min(height, y + tile_size_px)
        y0 = max(0, y1 - tile_size_px)
        while x < width:
            x1 = min(width, x + tile_size_px)
            x0 = max(0, x1 - tile_size_px)
            tiles.append(OcrTile(id=f"tile_{len(tiles) + 1:03d}", bbox_px=(x0, y0, x1, y1)))
            if x1 == width:
                break
            x += stride
        if y1 == height:
            break
        y += stride

    if len(tiles) > max_tiles:
        raise RasterOcrBudgetExceeded(f"OCR tile count {len(tiles)} exceeds budget {max_tiles}")
    return tiles
