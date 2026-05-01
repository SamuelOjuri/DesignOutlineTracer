from difflib import SequenceMatcher

from app.models.raster import RasterTextBlock


def merge_ocr_blocks(blocks: list[RasterTextBlock]) -> list[RasterTextBlock]:
    merged: list[RasterTextBlock] = []
    for block in sorted(blocks, key=lambda item: item.text_confidence, reverse=True):
        duplicate = next(
            (
                existing
                for existing in merged
                if _iou(existing.bbox_px, block.bbox_px) > 0.55
                and SequenceMatcher(None, existing.text.lower(), block.text.lower()).ratio() > 0.75
            ),
            None,
        )
        if duplicate is None:
            merged.append(block)
    return sorted(merged, key=lambda item: (item.bbox_px[1], item.bbox_px[0]))


def _iou(left: list[int], right: list[int]) -> float:
    x0 = max(left[0], right[0])
    y0 = max(left[1], right[1])
    x1 = min(left[2], right[2])
    y1 = min(left[3], right[3])
    intersection = max(0, x1 - x0) * max(0, y1 - y0)
    left_area = max(0, left[2] - left[0]) * max(0, left[3] - left[1])
    right_area = max(0, right[2] - right[0]) * max(0, right[3] - right[1])
    union = left_area + right_area - intersection
    return intersection / union if union else 0.0
