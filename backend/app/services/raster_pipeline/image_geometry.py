from pathlib import Path

import cv2
import numpy as np

from app.models.raster import ImageDerivedPrimitive, RasterSheetRegion


def extract_image_geometry(
    linework_path: Path,
    sheet_regions: list[RasterSheetRegion],
) -> list[ImageDerivedPrimitive]:
    image = cv2.imread(str(linework_path), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f"Could not read linework image: {linework_path}")
    viewport = next(region for region in sheet_regions if region.type == "drawing_viewport")
    x0, y0, x1, y1 = viewport.bbox_px
    crop = image[y0:y1, x0:x1]

    primitives: list[ImageDerivedPrimitive] = []
    lines = cv2.HoughLinesP(crop, 1, np.pi / 180, threshold=120, minLineLength=80, maxLineGap=12)
    if lines is not None:
        for index, line in enumerate(lines[:80], start=1):
            lx0, ly0, lx1, ly1 = [int(value) for value in line[0]]
            primitives.append(
                ImageDerivedPrimitive(
                    id=f"img_line_{index:03d}",
                    type="line",
                    method="hough_line_detection",
                    confidence=0.7,
                    start_px=[lx0 + x0, ly0 + y0],
                    end_px=[lx1 + x0, ly1 + y0],
                )
            )

    contours, _ = cv2.findContours(crop, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for index, contour in enumerate(contours[:40], start=1):
        area = cv2.contourArea(contour)
        if area < 500:
            continue
        x, y, w, h = cv2.boundingRect(contour)
        primitives.append(
            ImageDerivedPrimitive(
                id=f"img_contour_{index:03d}",
                type="contour",
                method="contour_extraction",
                confidence=0.58,
                bbox_px=[x + x0, y + y0, x + w + x0, y + h + y0],
            )
        )

    return primitives
