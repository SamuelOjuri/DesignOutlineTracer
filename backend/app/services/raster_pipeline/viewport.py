from pathlib import Path

from PIL import Image

from app.models.raster import RasterSheetRegion


def detect_raster_sheet_regions(image_path: Path) -> list[RasterSheetRegion]:
    with Image.open(image_path) as image:
        width, height = image.size

    return [
        RasterSheetRegion(
            type="drawing_viewport",
            bbox_px=[0, 0, int(width * 0.86), int(height * 0.88)],
            confidence=0.72,
        ),
        RasterSheetRegion(
            type="title_block",
            bbox_px=[int(width * 0.52), int(height * 0.86), width, height],
            confidence=0.7,
        ),
        RasterSheetRegion(
            type="notes",
            bbox_px=[int(width * 0.78), 0, width, int(height * 0.76)],
            confidence=0.58,
        ),
        RasterSheetRegion(
            type="drawing_border",
            bbox_px=[0, 0, width, height],
            confidence=0.8,
        ),
        RasterSheetRegion(
            type="revision_table",
            bbox_px=[int(width * 0.78), int(height * 0.66), width, int(height * 0.86)],
            confidence=0.55,
        ),
        RasterSheetRegion(
            type="legend",
            bbox_px=[0, int(height * 0.88), int(width * 0.35), height],
            confidence=0.45,
        ),
        RasterSheetRegion(
            type="scale_bar_region",
            bbox_px=[0, int(height * 0.88), int(width * 0.35), height],
            confidence=0.55,
        ),
    ]
