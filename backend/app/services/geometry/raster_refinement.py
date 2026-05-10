"""Raster-assisted refinement for vector-first roof candidates."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import fitz
import numpy as np
from shapely.geometry import LineString, Point, Polygon, box
from shapely.ops import nearest_points, snap, unary_union

from app.models.vector import PageMetadata, SheetRegion

DEFAULT_REFINEMENT_DPI = 200
MIN_FLOOD_AREA_PX = 256
MIN_REFINEMENT_IOU = 0.20
CANDIDATE_MASK_PADDING_PX = 8
ANCHOR_SNAP_DISTANCE_PDF = 100.0
EXCLUDED_REGION_TYPES = {"title_block", "legend", "notes"}


@dataclass(frozen=True)
class RefinedCandidate:
    polygon_pdf: Polygon
    raster_iou: float
    raster_clip_iou: float
    flood_seed_count: int
    bounded_by_linework: bool


def refine_candidate(
    *,
    candidate_polygon: Polygon,
    source_path: Path,
    page: PageMetadata,
    anchors_pdf: list[tuple[float, float]],
    sheet_regions: list[SheetRegion],
    excluded_polygons_pdf: list[Polygon] | None = None,
    semantic_clip_pdf: Polygon | None = None,
    vector_linework: list[LineString] | None = None,
    dpi: int = DEFAULT_REFINEMENT_DPI,
) -> RefinedCandidate | None:
    """Return a raster-refined candidate polygon, or None when evidence is weak."""
    original_candidate_polygon = _clean_polygon(candidate_polygon)
    if original_candidate_polygon is None:
        return None
    candidate_polygon = _clean_polygon(candidate_polygon)
    if candidate_polygon is None or candidate_polygon.area <= 0 or not anchors_pdf:
        return None
    candidate_polygon = _clip_candidate_to_semantic_support(
        candidate_polygon,
        semantic_clip_pdf,
        anchors_pdf,
    )
    if candidate_polygon is None or candidate_polygon.area <= 0:
        return None

    image = _render_page_grayscale(source_path, page, dpi=dpi)
    if image is None:
        return None
    scale_x = image.shape[1] / page.page_width
    scale_y = image.shape[0] / page.page_height

    walls = _wall_mask(image)
    walls = _mask_sheet_regions(walls, sheet_regions, scale_x, scale_y)
    if excluded_polygons_pdf:
        walls = _mask_polygons(walls, excluded_polygons_pdf, scale_x, scale_y)

    candidate_mask = _polygon_mask(candidate_polygon, walls.shape, scale_x, scale_y)
    if candidate_mask is None:
        return None
    walls = _seal_with_candidate_mask(walls, candidate_mask)

    flood_mask = np.zeros(walls.shape, dtype=np.uint8)
    seeds_used = 0
    for anchor in anchors_pdf:
        snapped_anchor = _snap_anchor_into_candidate(anchor, candidate_polygon)
        if snapped_anchor is None:
            continue
        seed = _anchor_to_pixel(snapped_anchor, scale_x, scale_y, walls.shape)
        if seed is None or candidate_mask[seed[1], seed[0]] == 0:
            continue
        free_seed = _nearest_free_seed(walls, seed)
        if free_seed is None or candidate_mask[free_seed[1], free_seed[0]] == 0:
            continue
        single_mask = cv2.bitwise_and(_flood_fill_region(walls, free_seed), candidate_mask)
        if int(np.count_nonzero(single_mask)) < MIN_FLOOD_AREA_PX:
            continue
        flood_mask = cv2.bitwise_or(flood_mask, single_mask)
        seeds_used += 1

    if seeds_used == 0:
        return None

    flood_mask = _solidify_scope_mask(flood_mask, containing_mask=candidate_mask)
    flood_mask = _remove_thin_appendages(flood_mask)
    raster_polygon = _polygon_from_mask(flood_mask, scale_x, scale_y)
    if raster_polygon is None:
        return None
    raster_polygon = _subtract_excluded_regions(
        raster_polygon,
        sheet_regions,
        excluded_polygons_pdf or [],
    )
    raster_polygon = _remove_narrow_polygon_appendages(raster_polygon, page)
    if raster_polygon is None or raster_polygon.area <= 0:
        return None

    refined = candidate_polygon.intersection(raster_polygon)
    if refined.is_empty or refined.area <= 0:
        refined = raster_polygon
    refined = _clean_polygon(refined)
    if refined is None or refined.area <= 0:
        return None
    if vector_linework:
        refined = _snap_to_linework(refined, vector_linework)
    refined = _clean_polygon(refined.buffer(0.25).buffer(-0.25)) or refined
    refined = _clean_boundary_jogs(refined, page)
    refined = refined.simplify(0.5, preserve_topology=True)

    raster_iou = _iou(raster_polygon, original_candidate_polygon)
    raster_clip_iou = _iou(raster_polygon, candidate_polygon)
    if raster_iou < MIN_REFINEMENT_IOU:
        return None
    return RefinedCandidate(
        polygon_pdf=refined,
        raster_iou=round(raster_iou, 4),
        raster_clip_iou=round(raster_clip_iou, 4),
        flood_seed_count=seeds_used,
        bounded_by_linework=True,
    )


def recover_hough_linework(
    *,
    source_path: Path,
    page: PageMetadata,
    sheet_regions: list[SheetRegion],
    dpi: int = DEFAULT_REFINEMENT_DPI,
) -> list[LineString]:
    """Recover long orthogonal raster line segments missed by PDF vector extraction."""
    image = _render_page_grayscale(source_path, page, dpi=dpi)
    if image is None:
        return []
    scale_x = image.shape[1] / page.page_width
    scale_y = image.shape[0] / page.page_height
    walls = _mask_sheet_regions(_wall_mask(image), sheet_regions, scale_x, scale_y)
    edges = cv2.Canny(walls, 50, 150, apertureSize=3)
    lines = cv2.HoughLinesP(
        edges,
        1,
        np.pi / 180,
        threshold=80,
        minLineLength=120,
        maxLineGap=18,
    )
    if lines is None:
        return []

    segments: list[LineString] = []
    for line in lines[:, 0, :]:
        x0, y0, x1, y1 = [int(value) for value in line]
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        if dx < 60 and dy < 60:
            continue
        if dx >= max(60, dy * 5):
            y_pdf = round(((y0 + y1) / 2) / scale_y, 1)
            segment = LineString(
                [
                    (round(min(x0, x1) / scale_x, 1), y_pdf),
                    (round(max(x0, x1) / scale_x, 1), y_pdf),
                ]
            )
        elif dy >= max(60, dx * 5):
            x_pdf = round(((x0 + x1) / 2) / scale_x, 1)
            segment = LineString(
                [
                    (x_pdf, round(min(y0, y1) / scale_y, 1)),
                    (x_pdf, round(max(y0, y1) / scale_y, 1)),
                ]
            )
        else:
            continue
        if segment.length >= 45:
            segments.append(segment)
    return _dedupe_lines(segments)


def _render_page_grayscale(source_path: Path, page: PageMetadata, *, dpi: int) -> np.ndarray | None:
    try:
        with fitz.open(source_path) as document:
            page_index = max(0, page.page_number - 1)
            if page_index >= document.page_count:
                return None
            pixmap = document[page_index].get_pixmap(
                matrix=fitz.Matrix(dpi / 72.0, dpi / 72.0),
                alpha=False,
            )
            pixels = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
                pixmap.height,
                pixmap.width,
                pixmap.n,
            )
            if pixmap.n >= 3:
                return cv2.cvtColor(pixels[:, :, :3], cv2.COLOR_RGB2GRAY)
            return pixels[:, :, 0].copy()
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


def _mask_sheet_regions(
    walls: np.ndarray,
    sheet_regions: list[SheetRegion],
    scale_x: float,
    scale_y: float,
) -> np.ndarray:
    excluded = [
        box(*region.bbox_pdf) for region in sheet_regions if region.type in EXCLUDED_REGION_TYPES
    ]
    return _mask_polygons(walls, excluded, scale_x, scale_y)


def _mask_polygons(
    walls: np.ndarray,
    polygons: list[Polygon],
    scale_x: float,
    scale_y: float,
) -> np.ndarray:
    output = walls.copy()
    for polygon in polygons:
        mask = _polygon_mask(polygon, output.shape, scale_x, scale_y, padding_px=0)
        if mask is not None:
            output[mask > 0] = 255
    return output


def _polygon_mask(
    polygon: Polygon,
    shape: tuple[int, int],
    scale_x: float,
    scale_y: float,
    *,
    padding_px: int = CANDIDATE_MASK_PADDING_PX,
) -> np.ndarray | None:
    polygon = _clean_polygon(polygon)
    if polygon is None or polygon.is_empty:
        return None
    mask = np.zeros(shape, dtype=np.uint8)
    geometries = [polygon] if isinstance(polygon, Polygon) else list(getattr(polygon, "geoms", []))
    for geom in geometries:
        if not isinstance(geom, Polygon) or geom.is_empty:
            continue
        exterior = np.array(
            [(int(round(x * scale_x)), int(round(y * scale_y))) for x, y in geom.exterior.coords],
            dtype=np.int32,
        )
        if exterior.shape[0] >= 3:
            cv2.fillPoly(mask, [exterior], 255)
        for interior in geom.interiors:
            hole = np.array(
                [(int(round(x * scale_x)), int(round(y * scale_y))) for x, y in interior.coords],
                dtype=np.int32,
            )
            if hole.shape[0] >= 3:
                cv2.fillPoly(mask, [hole], 0)
    if padding_px > 0:
        mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=padding_px)
    return mask if int(np.count_nonzero(mask)) else None


def _seal_with_candidate_mask(walls: np.ndarray, candidate_mask: np.ndarray) -> np.ndarray:
    output = walls.copy()
    output[candidate_mask == 0] = 255
    return output


def _clip_candidate_to_semantic_support(
    candidate: Polygon,
    semantic_clip: Polygon | None,
    anchors_pdf: list[tuple[float, float]],
) -> Polygon | None:
    semantic_clip = _clean_polygon(semantic_clip)
    if semantic_clip is None or semantic_clip.is_empty:
        return candidate
    clipped = _clean_polygon(candidate.intersection(semantic_clip))
    if clipped is None or clipped.area <= 0:
        return candidate
    if clipped.area < candidate.area * 0.04:
        return candidate
    if not any(
        clipped.buffer(ANCHOR_SNAP_DISTANCE_PDF).contains(Point(anchor)) for anchor in anchors_pdf
    ):
        return candidate
    return clipped


def _snap_anchor_into_candidate(
    anchor: tuple[float, float],
    candidate: Polygon,
) -> tuple[float, float] | None:
    point = Point(anchor)
    if candidate.contains(point):
        return anchor
    if candidate.distance(point) > ANCHOR_SNAP_DISTANCE_PDF:
        return None
    boundary_point = nearest_points(candidate.boundary, point)[0]
    interior = candidate.representative_point()
    dx = interior.x - boundary_point.x
    dy = interior.y - boundary_point.y
    distance = (dx * dx + dy * dy) ** 0.5
    if distance <= 0:
        return float(interior.x), float(interior.y)
    snapped = (float(boundary_point.x + dx / distance), float(boundary_point.y + dy / distance))
    return snapped if candidate.contains(Point(snapped)) else (float(interior.x), float(interior.y))


def _anchor_to_pixel(
    anchor: tuple[float, float],
    scale_x: float,
    scale_y: float,
    shape: tuple[int, int],
) -> tuple[int, int] | None:
    height, width = shape
    x_value = int(round(anchor[0] * scale_x))
    y_value = int(round(anchor[1] * scale_y))
    if x_value < 0 or y_value < 0 or x_value >= width or y_value >= height:
        return None
    return x_value, y_value


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
    fill_source = free.copy()
    flood_mask = np.zeros((free.shape[0] + 2, free.shape[1] + 2), np.uint8)
    cv2.floodFill(fill_source, flood_mask, seed, 128)
    return np.where(fill_source == 128, 255, 0).astype(np.uint8)


def _solidify_scope_mask(mask: np.ndarray, containing_mask: np.ndarray | None = None) -> np.ndarray:
    if int(np.count_nonzero(mask)) < MIN_FLOOD_AREA_PX:
        return mask
    binary = np.where(mask > 0, 255, 0).astype(np.uint8)
    closed = cv2.morphologyEx(binary, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
    fill_source = closed.copy()
    if containing_mask is not None:
        fill_source[containing_mask == 0] = 255
    flood_mask = np.zeros((closed.shape[0] + 2, closed.shape[1] + 2), np.uint8)
    cv2.floodFill(fill_source, flood_mask, (0, 0), 255)
    holes = cv2.bitwise_not(fill_source)
    if containing_mask is not None:
        holes = cv2.bitwise_and(holes, containing_mask)
    solid = cv2.bitwise_or(closed, holes)
    return cv2.morphologyEx(solid, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8), iterations=1)


def _remove_thin_appendages(mask: np.ndarray) -> np.ndarray:
    if int(np.count_nonzero(mask)) < MIN_FLOOD_AREA_PX:
        return mask
    min_dimension = min(mask.shape)
    min_width_px = max(24, min(72, int(round(min_dimension * 0.05))))
    if min_width_px % 2 == 0:
        min_width_px += 1
    binary = np.where(mask > 0, 255, 0).astype(np.uint8)
    vertical_opened = cv2.morphologyEx(
        binary,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, min_width_px)),
        iterations=1,
    )
    horizontal_opened = cv2.morphologyEx(
        binary,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (min_width_px, 1)),
        iterations=1,
    )
    axis_opened = cv2.bitwise_and(vertical_opened, horizontal_opened)
    if int(np.count_nonzero(axis_opened)) >= max(
        MIN_FLOOD_AREA_PX,
        int(np.count_nonzero(binary) * 0.35),
    ):
        return axis_opened

    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (min_width_px, min_width_px))
    core = cv2.erode(binary, kernel, iterations=1)
    if int(np.count_nonzero(core)) < MIN_FLOOD_AREA_PX:
        return binary

    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(core, connectivity=8)
    kept_core = np.zeros_like(core)
    for label in range(1, component_count):
        if int(stats[label, cv2.CC_STAT_AREA]) >= MIN_FLOOD_AREA_PX:
            kept_core[labels == label] = 255
    if int(np.count_nonzero(kept_core)) == 0:
        return binary
    rebuilt = cv2.dilate(kept_core, kernel, iterations=1)
    return cv2.bitwise_and(rebuilt, binary)


def _polygon_from_mask(mask: np.ndarray, scale_x: float, scale_y: float) -> Polygon | None:
    if int(np.count_nonzero(mask)) < MIN_FLOOD_AREA_PX:
        return None
    contours, _ = cv2.findContours(
        np.where(mask > 0, 255, 0).astype(np.uint8),
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )
    polygons: list[Polygon] = []
    for contour in contours:
        points_px = contour.reshape(-1, 2)
        if points_px.shape[0] < 4:
            continue
        points = [(float(col) / scale_x, float(row) / scale_y) for col, row in points_px]
        polygon = _clean_polygon(Polygon(points))
        if polygon is not None and polygon.area > 0:
            polygons.append(polygon)
    if not polygons:
        return None
    return max(polygons, key=lambda polygon: polygon.area)


def _subtract_excluded_regions(
    polygon: Polygon,
    sheet_regions: list[SheetRegion],
    excluded_polygons: list[Polygon],
) -> Polygon | None:
    exclusions = [
        box(*region.bbox_pdf) for region in sheet_regions if region.type in EXCLUDED_REGION_TYPES
    ]
    exclusions.extend(excluded_polygons)
    if not exclusions:
        return polygon
    return _clean_polygon(polygon.difference(unary_union(exclusions)))


def _remove_narrow_polygon_appendages(
    polygon: Polygon | None, page: PageMetadata
) -> Polygon | None:
    polygon = _clean_polygon(polygon)
    if polygon is None or polygon.is_empty:
        return None
    distance = max(10.0, min(24.0, min(page.page_width, page.page_height) * 0.03))
    opened = _clean_polygon(polygon.buffer(-distance, join_style=2).buffer(distance, join_style=2))
    if opened is None or opened.area < polygon.area * 0.35:
        opened = polygon
    trimmed = _trim_edge_protrusions(opened, page)
    if trimmed is not None and trimmed.area >= polygon.area * 0.35:
        return trimmed
    return opened


def _trim_edge_protrusions(polygon: Polygon, page: PageMetadata) -> Polygon | None:
    threshold = max(8.0, min(24.0, min(page.page_width, page.page_height) * 0.025))
    trimmed = polygon
    for axis, low_side in (("y", True), ("y", False), ("x", True), ("x", False)):
        candidate = _trim_single_edge_protrusion(
            trimmed, axis=axis, low_side=low_side, threshold=threshold
        )
        if candidate is not None and candidate.area >= polygon.area * 0.35:
            trimmed = candidate
    return _clean_polygon(trimmed)


def _trim_single_edge_protrusion(
    polygon: Polygon,
    *,
    axis: str,
    low_side: bool,
    threshold: float,
) -> Polygon | None:
    coords = list(polygon.exterior.coords)[:-1]
    index = 1 if axis == "y" else 0
    values = sorted({round(float(point[index]), 3) for point in coords})
    if len(values) < 2:
        return None
    edge_value = values[0] if low_side else values[-1]
    cut_value = values[1] if low_side else values[-2]
    if abs(cut_value - edge_value) > threshold:
        return None

    min_x, min_y, max_x, max_y = polygon.bounds
    padding = 1.0
    if axis == "y":
        protrusion = polygon.intersection(
            box(
                min_x - padding,
                min(edge_value, cut_value),
                max_x + padding,
                max(edge_value, cut_value),
            )
        )
        keep = box(
            min_x - padding,
            cut_value if low_side else min_y - padding,
            max_x + padding,
            max_y + padding if low_side else cut_value,
        )
    else:
        protrusion = polygon.intersection(
            box(
                min(edge_value, cut_value),
                min_y - padding,
                max(edge_value, cut_value),
                max_y + padding,
            )
        )
        keep = box(
            cut_value if low_side else min_x - padding,
            min_y - padding,
            max_x + padding if low_side else cut_value,
            max_y + padding,
        )
    if protrusion.is_empty or protrusion.area > polygon.area * 0.12:
        return None
    return _clean_polygon(polygon.intersection(keep))


def _snap_to_linework(polygon: Polygon, vector_linework: list[LineString]) -> Polygon:
    linework = unary_union(vector_linework)
    snapped = snap(polygon, linework, 2.0)
    return _clean_polygon(snapped) or polygon


def _clean_boundary_jogs(polygon: Polygon, page: PageMetadata) -> Polygon:
    if polygon.interiors:
        return polygon
    tolerance = max(0.75, min(2.5, min(page.page_width, page.page_height) * 0.004))
    coords = list(polygon.exterior.coords)[:-1]
    if len(coords) <= 4:
        return polygon

    cleaned_coords = coords
    for _ in range(3):
        next_coords: list[tuple[float, float]] = []
        changed = False
        for index, point in enumerate(cleaned_coords):
            previous = cleaned_coords[index - 1]
            following = cleaned_coords[(index + 1) % len(cleaned_coords)]
            if len(cleaned_coords) - int(changed) > 4 and _is_boundary_jog(
                previous,
                point,
                following,
                tolerance=tolerance,
            ):
                changed = True
                continue
            next_coords.append(point)
        cleaned_coords = next_coords
        if not changed or len(cleaned_coords) <= 4:
            break

    cleaned = _clean_polygon(Polygon(cleaned_coords))
    if cleaned is None or cleaned.area < polygon.area * 0.995:
        return polygon
    return cleaned


def _is_boundary_jog(
    previous: tuple[float, float],
    current: tuple[float, float],
    following: tuple[float, float],
    *,
    tolerance: float,
) -> bool:
    previous_point = Point(previous)
    current_point = Point(current)
    following_point = Point(following)
    if previous_point.distance(current_point) <= tolerance:
        return True
    if current_point.distance(following_point) <= tolerance:
        return True
    baseline = LineString([previous, following])
    if baseline.length <= tolerance:
        return False
    return bool(current_point.distance(baseline) <= tolerance)


def _iou(left: Polygon, right: Polygon) -> float:
    if left.is_empty or right.is_empty:
        return 0.0
    union_area = left.union(right).area
    if union_area <= 0:
        return 0.0
    return float(left.intersection(right).area / union_area)


def _clean_polygon(geometry: object) -> Polygon | None:
    if not isinstance(geometry, Polygon):
        polygons = [geom for geom in getattr(geometry, "geoms", []) if isinstance(geom, Polygon)]
        if not polygons:
            return None
        geometry = max(polygons, key=lambda polygon: polygon.area)
    if geometry.is_empty:
        return None
    repaired = geometry.buffer(0)
    if isinstance(repaired, Polygon) and not repaired.is_empty:
        return repaired
    polygons = [geom for geom in getattr(repaired, "geoms", []) if isinstance(geom, Polygon)]
    return max(polygons, key=lambda polygon: polygon.area) if polygons else None


def _dedupe_lines(segments: list[LineString]) -> list[LineString]:
    unique: list[LineString] = []
    seen: set[tuple[float, float, float, float]] = set()
    for segment in segments:
        coords = list(segment.coords)
        if len(coords) < 2:
            continue
        x0, y0 = coords[0]
        x1, y1 = coords[-1]
        key = (round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1))
        reverse_key = (key[2], key[3], key[0], key[1])
        if key in seen or reverse_key in seen:
            continue
        seen.add(key)
        unique.append(segment)
    return unique
