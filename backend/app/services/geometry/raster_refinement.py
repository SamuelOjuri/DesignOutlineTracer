"""OpenCV/Shapely refinement of vector_first candidate polygons.

This module rasterises the source PDF, builds a wall mask with OpenCV, and
flood-fills from semantic anchors (RWPs, rooflights, drainage symbols) to
recover the true roof boundary even when vector polygonisation had to bridge
synthetic axis-aligned gaps. The traced contour is reconciled with the
input candidate polygon via Shapely intersection, which removes spurious
over-coverage (for example title-block or PV-array intrusions).

The refinement is purely additive: callers receive a refined polygon plus an
intersection-over-union score against the original candidate, and may decide
whether to promote it to an auto-exportable candidate.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import fitz
import numpy as np
from shapely.geometry import Point, Polygon, box
from shapely.ops import nearest_points, unary_union

from app.models.vector import PageMetadata, SheetRegion

DEFAULT_REFINEMENT_DPI = 200
EXCLUDED_REGION_TYPES: frozenset[str] = frozenset(
    {"title_block", "legend", "notes"},
)
MIN_FLOOD_AREA_PX = 256
MIN_REFINEMENT_IOU = 0.20
# Pixel padding applied to the candidate polygon when rasterising it as a
# bounding mask for the flood fill. Larger values let the refinement recover
# slightly outside the candidate; smaller values keep the result tight.
CANDIDATE_BBOX_PADDING_PX = 8


@dataclass(frozen=True)
class RefinementResult:
    """Outcome of a single raster-driven candidate refinement."""

    polygon_pdf: Polygon
    raster_iou: float
    flood_seed_count: int
    bounded_by_linework: bool


def refine_polygon_with_raster(
    *,
    candidate_polygon: Polygon,
    anchors_pdf: list[tuple[float, float]],
    source_path: Path,
    page: PageMetadata,
    sheet_regions: list[SheetRegion],
    dpi: int = DEFAULT_REFINEMENT_DPI,
) -> RefinementResult | None:
    """Return a flood-fill-refined polygon for ``candidate_polygon`` or None.

    The candidate is re-traced against rasterised wall linework so synthetic
    gap bridges in the vector polygon are clipped back to real boundaries.
    Returns None when no refinement could be derived (no anchors, all seeds
    fall on linework, no closed flood region, or refinement disagrees with
    the candidate so strongly that the result would be unreliable).
    """
    if candidate_polygon.is_empty or candidate_polygon.area <= 0:
        return None
    if not anchors_pdf:
        return None

    image = _render_page(source_path, page, dpi=dpi)
    if image is None:
        return None
    scale_x = image.shape[1] / page.page_width
    scale_y = image.shape[0] / page.page_height

    walls = _wall_mask(image)
    walls = _mask_excluded_regions(walls, sheet_regions, scale_x, scale_y)
    # Bound the flood fill by the candidate polygon: rasterise the candidate
    # boundary onto the wall mask so flood fill cannot escape outside it.
    candidate_mask = _candidate_mask(
        candidate_polygon, walls.shape, scale_x, scale_y
    )
    if candidate_mask is None:
        return None
    walls = _seal_with_candidate_boundary(walls, candidate_mask)
    candidate_area_px = float(np.count_nonzero(candidate_mask))
    if candidate_area_px <= 0:
        return None

    flood_mask = np.zeros(walls.shape, dtype=np.uint8)
    seeds_used = 0
    for anchor in anchors_pdf:
        snapped = _snap_anchor_into_candidate(anchor, candidate_polygon)
        if snapped is None:
            continue
        seed = _anchor_to_pixel(snapped, scale_x, scale_y, walls.shape)
        if seed is None:
            continue
        if candidate_mask[seed[1], seed[0]] == 0:
            continue
        seed = _nearest_free_seed(walls, seed)
        if seed is None:
            continue
        if candidate_mask[seed[1], seed[0]] == 0:
            continue
        single = _flood_fill_region(walls, seed)
        # Clip the per-seed flood by the candidate region; this stops fills
        # that escape through hairline gaps in the wall mask.
        single = cv2.bitwise_and(single, candidate_mask)
        single_area = int(np.count_nonzero(single))
        if single_area < MIN_FLOOD_AREA_PX:
            continue
        # The candidate mask already bounds the flood, so a flood that fills
        # the entire candidate just means the raster agrees with the vector
        # candidate (IoU close to 1.0).
        flood_mask = cv2.bitwise_or(flood_mask, single)
        seeds_used += 1
    if seeds_used == 0:
        return None

    polygon = _polygon_from_mask(flood_mask, scale_x, scale_y)
    if polygon is None:
        return None

    refined = _intersect_with_candidate(polygon, candidate_polygon)
    if refined is None or refined.is_empty or refined.area <= 0:
        return None
    refined = _clean_polygon(refined)
    if refined is None or refined.area <= 0:
        return None

    iou = _iou(refined, candidate_polygon)
    if iou < MIN_REFINEMENT_IOU:
        return None

    return RefinementResult(
        polygon_pdf=refined,
        raster_iou=round(iou, 4),
        flood_seed_count=seeds_used,
        bounded_by_linework=True,
    )


def _render_page(source_path: Path, page: PageMetadata, *, dpi: int) -> np.ndarray | None:
    try:
        with fitz.open(source_path) as document:
            page_index = max(0, page.page_number - 1)
            if page_index >= document.page_count:
                return None
            target_page = document[page_index]
            scale = dpi / 72.0
            pixmap = target_page.get_pixmap(
                matrix=fitz.Matrix(scale, scale),
                alpha=False,
            )
            buffer = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height, pixmap.width, pixmap.n
            )
            if pixmap.n >= 3:
                rgb = buffer[:, :, :3]
                return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
            return buffer[:, :, 0].copy()
    except Exception:
        return None


def _wall_mask(gray: np.ndarray) -> np.ndarray:
    denoised = cv2.fastNlMeansDenoising(gray, h=7)
    equalised = cv2.equalizeHist(denoised)
    binary = cv2.adaptiveThreshold(
        equalised,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        31,
        9,
    )
    kernel = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, kernel, iterations=2)
    return cv2.dilate(closed, kernel, iterations=1)


def _mask_excluded_regions(
    walls: np.ndarray,
    sheet_regions: list[SheetRegion],
    scale_x: float,
    scale_y: float,
) -> np.ndarray:
    output = walls.copy()
    height, width = walls.shape
    for region in sheet_regions:
        if region.type not in EXCLUDED_REGION_TYPES:
            continue
        x0 = max(0, int(np.floor(region.bbox_pdf[0] * scale_x)))
        y0 = max(0, int(np.floor(region.bbox_pdf[1] * scale_y)))
        x1 = min(width, int(np.ceil(region.bbox_pdf[2] * scale_x)))
        y1 = min(height, int(np.ceil(region.bbox_pdf[3] * scale_y)))
        if x1 <= x0 or y1 <= y0:
            continue
        # Fill the excluded region with wall pixels so flood fill cannot leak
        # into it.
        output[y0:y1, x0:x1] = 255
    return output


def _snap_anchor_into_candidate(
    anchor: tuple[float, float],
    candidate: Polygon,
    *,
    inward_offset: float = 1.0,
    max_snap_distance: float = 100.0,
) -> tuple[float, float] | None:
    """Return ``anchor`` if inside ``candidate``; otherwise project to the
    nearest interior point. Returns None when the anchor is too far away."""
    point = Point(anchor[0], anchor[1])
    if candidate.contains(point):
        return anchor
    if candidate.distance(point) > max_snap_distance:
        return None
    boundary_point = nearest_points(candidate.boundary, point)[0]
    centroid = candidate.representative_point()
    dx = centroid.x - boundary_point.x
    dy = centroid.y - boundary_point.y
    norm = (dx * dx + dy * dy) ** 0.5
    if norm == 0:
        return float(boundary_point.x), float(boundary_point.y)
    factor = inward_offset / norm
    snapped = (
        float(boundary_point.x) + dx * factor,
        float(boundary_point.y) + dy * factor,
    )
    if not candidate.contains(Point(*snapped)):
        # As a last resort, use the candidate's interior representative point.
        return float(centroid.x), float(centroid.y)
    return snapped


def _anchor_to_pixel(
    anchor: tuple[float, float],
    scale_x: float,
    scale_y: float,
    shape: tuple[int, int],
) -> tuple[int, int] | None:
    height, width = shape
    px = int(round(anchor[0] * scale_x))
    py = int(round(anchor[1] * scale_y))
    if px < 0 or py < 0 or px >= width or py >= height:
        return None
    return px, py


def _nearest_free_seed(
    walls: np.ndarray,
    seed: tuple[int, int],
    *,
    radius: int = 60,
) -> tuple[int, int] | None:
    x_seed, y_seed = seed
    if walls[y_seed, x_seed] == 0:
        return seed
    height, width = walls.shape
    x_min = max(0, x_seed - radius)
    x_max = min(width, x_seed + radius + 1)
    y_min = max(0, y_seed - radius)
    y_max = min(height, y_seed + radius + 1)
    window = walls[y_min:y_max, x_min:x_max]
    free = np.column_stack(np.where(window == 0))
    if free.size == 0:
        return None
    distances = (free[:, 1] - (x_seed - x_min)) ** 2 + (free[:, 0] - (y_seed - y_min)) ** 2
    nearest = free[int(np.argmin(distances))]
    return int(nearest[1] + x_min), int(nearest[0] + y_min)


def _flood_fill_region(walls: np.ndarray, seed: tuple[int, int]) -> np.ndarray:
    free = np.where(walls > 0, 0, 255).astype(np.uint8)
    fill_mask = np.zeros((free.shape[0] + 2, free.shape[1] + 2), np.uint8)
    cv2.floodFill(free, fill_mask, seed, 128)
    return np.where(free == 128, 255, 0).astype(np.uint8)


def _polygon_from_mask(
    mask: np.ndarray,
    scale_x: float,
    scale_y: float,
) -> Polygon | None:
    if int(np.count_nonzero(mask)) < MIN_FLOOD_AREA_PX:
        return None
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    largest = max(contours, key=cv2.contourArea)
    if cv2.contourArea(largest) < MIN_FLOOD_AREA_PX:
        return None
    epsilon = max(2.0, 0.0025 * cv2.arcLength(largest, True))
    approx = cv2.approxPolyDP(largest, epsilon, True)
    if approx.shape[0] < 3:
        return None
    points = [
        (float(point[0][0]) / scale_x, float(point[0][1]) / scale_y)
        for point in approx
    ]
    polygon = Polygon(points)
    polygon = _clean_polygon(polygon)
    return polygon


def _intersect_with_candidate(
    refined: Polygon,
    candidate: Polygon,
) -> Polygon | None:
    candidate = candidate if candidate.is_valid else candidate.buffer(0)
    refined = refined if refined.is_valid else refined.buffer(0)
    intersection = refined.intersection(candidate)
    if intersection.is_empty or intersection.area <= 0:
        return None
    if isinstance(intersection, Polygon):
        return intersection
    polygons = [geom for geom in getattr(intersection, "geoms", []) if isinstance(geom, Polygon)]
    if not polygons:
        return None
    return max(polygons, key=lambda geom: geom.area)


def _candidate_mask(
    candidate: Polygon,
    shape: tuple[int, int],
    scale_x: float,
    scale_y: float,
) -> np.ndarray | None:
    """Rasterise ``candidate`` into a uint8 mask (255 inside, 0 outside)."""
    if candidate.is_empty:
        return None
    poly = candidate if candidate.is_valid else candidate.buffer(0)
    if poly.is_empty:
        return None
    height, width = shape
    mask = np.zeros(shape, dtype=np.uint8)
    geometries = [poly] if isinstance(poly, Polygon) else list(getattr(poly, "geoms", []))
    for geom in geometries:
        if not isinstance(geom, Polygon) or geom.is_empty:
            continue
        exterior = np.array(
            [
                (int(round(x * scale_x)), int(round(y * scale_y)))
                for x, y in geom.exterior.coords
            ],
            dtype=np.int32,
        )
        if exterior.shape[0] < 3:
            continue
        cv2.fillPoly(mask, [exterior], 255)
        for interior in geom.interiors:
            holes = np.array(
                [
                    (int(round(x * scale_x)), int(round(y * scale_y)))
                    for x, y in interior.coords
                ],
                dtype=np.int32,
            )
            if holes.shape[0] >= 3:
                cv2.fillPoly(mask, [holes], 0)
    if CANDIDATE_BBOX_PADDING_PX > 0:
        kernel = np.ones((3, 3), np.uint8)
        mask = cv2.dilate(mask, kernel, iterations=CANDIDATE_BBOX_PADDING_PX)
    if int(np.count_nonzero(mask)) <= 0:
        return None
    _ = (height, width)
    return mask


def _seal_with_candidate_boundary(
    walls: np.ndarray,
    candidate_mask: np.ndarray,
) -> np.ndarray:
    """Treat the candidate's outside as a wall so flood fill cannot escape."""
    output = walls.copy()
    output[candidate_mask == 0] = 255
    return output


def _iou(left: Polygon, right: Polygon) -> float:
    if left.is_empty or right.is_empty:
        return 0.0
    union_area = unary_union([left, right]).area
    if union_area <= 0:
        return 0.0
    intersection_area = left.intersection(right).area
    return float(intersection_area / union_area)


def _clean_polygon(polygon: Polygon) -> Polygon | None:
    if polygon.is_empty:
        return None
    repaired = polygon.buffer(0)
    if repaired.is_empty:
        return None
    if isinstance(repaired, Polygon):
        return repaired
    polygons = [geom for geom in getattr(repaired, "geoms", []) if isinstance(geom, Polygon)]
    if not polygons:
        return None
    return max(polygons, key=lambda geom: geom.area)


def excluded_region_polygons(sheet_regions: list[SheetRegion]) -> list[Polygon]:
    """Return PDF-coordinate polygons for sheet regions that should never be
    inside a refined candidate."""
    regions: list[Polygon] = []
    for region in sheet_regions:
        if region.type not in EXCLUDED_REGION_TYPES:
            continue
        regions.append(box(*region.bbox_pdf))
    return regions
