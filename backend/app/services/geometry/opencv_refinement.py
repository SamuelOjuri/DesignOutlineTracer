from collections.abc import Sequence
from pathlib import Path

import cv2
import fitz
import numpy as np
from shapely.geometry import MultiPolygon, Point, Polygon, box

from app.models.candidates import (
    CandidateRegion,
    OpenCvRefinementMetrics,
    RefinedCandidateResult,
    SemanticZone,
)
from app.models.vector import VectorDocument
from app.services.geometry.candidates import _rwp_labels_in_text

MIN_REFINED_AREA_RATIO = 0.35
MAX_REFINED_AREA_RATIO = 1.08
MIN_ANCHOR_RETENTION = 0.65


def refine_candidate_with_opencv(
    *,
    source_path: Path,
    vector_document: VectorDocument,
    candidate: CandidateRegion,
    semantic_zones: Sequence[SemanticZone] = (),
    render_dpi: int = 220,
) -> RefinedCandidateResult:
    candidate_polygon = _candidate_polygon(candidate)
    if candidate_polygon.is_empty or candidate_polygon.area <= 0:
        return _rejected(candidate.id, "invalid_source_candidate")

    image, scale = _render_pdf_page(source_path, render_dpi)
    image_shape = image.shape[:2]
    candidate_mask = _polygon_mask(candidate_polygon, image_shape, scale)
    if int(cv2.countNonZero(candidate_mask)) == 0:
        return _rejected(candidate.id, "candidate_mask_empty")

    exclusion_mask = _semantic_exclusion_mask(
        semantic_zones=semantic_zones,
        image_shape=image_shape,
        scale=scale,
        page_width=vector_document.page_metadata[0].page_width,
        page_height=vector_document.page_metadata[0].page_height,
        candidate_polygon=candidate_polygon,
    )
    refined_mask = cv2.bitwise_and(candidate_mask, cv2.bitwise_not(exclusion_mask))
    refined_mask = _clean_mask(refined_mask)

    linework_mask = _linework_mask(image)
    linework_mask = cv2.bitwise_and(linework_mask, cv2.bitwise_not(exclusion_mask))
    boundary_band = _boundary_band(refined_mask)
    boundary_support_ratio = _boundary_support_ratio(linework_mask, boundary_band)

    anchors = _anchor_points(vector_document, candidate_polygon)
    contour_polygon = _best_contour_polygon(
        refined_mask=refined_mask,
        scale=scale,
        anchors=anchors,
        original_polygon=candidate_polygon,
    )
    if contour_polygon is None:
        contour_polygon = candidate_polygon

    cleaned_polygon = _snap_polygon_to_vector_linework(
        _clean_polygon(contour_polygon),
        vector_document,
    )
    if cleaned_polygon.is_empty or cleaned_polygon.area <= 0:
        return _rejected(candidate.id, "refined_polygon_empty")

    anchor_retention = _anchor_retention(cleaned_polygon, anchors)
    area_change_ratio = min(
        1.0,
        abs(float(cleaned_polygon.area) - float(candidate_polygon.area))
        / max(float(candidate_polygon.area), 1.0),
    )
    removed_area_ratio = min(
        1.0,
        max(0.0, float(candidate_polygon.area) - float(cleaned_polygon.area))
        / max(float(candidate_polygon.area), 1.0),
    )
    edge_snap_ratio = _axis_aligned_edge_ratio(cleaned_polygon)
    metrics = OpenCvRefinementMetrics(
        edge_snap_ratio=edge_snap_ratio,
        boundary_support_ratio=boundary_support_ratio,
        excluded_region_removed_area_ratio=round(removed_area_ratio, 4),
        semantic_anchor_retention=anchor_retention,
        area_change_ratio=round(area_change_ratio, 4),
    )

    warnings = _refinement_warnings(
        candidate_polygon=candidate_polygon,
        refined_polygon=cleaned_polygon,
        metrics=metrics,
        anchors=anchors,
    )
    accepted = not any(
        warning
        in {
            "refined_polygon_invalid",
            "refined_polygon_lost_semantic_anchors",
            "refined_area_too_small",
            "refined_area_too_large",
        }
        for warning in warnings
    )
    return RefinedCandidateResult(
        accepted=accepted,
        source_candidate_id=candidate.id,
        polygon_pdf=_polygon_points(cleaned_polygon if accepted else candidate_polygon),
        metrics=metrics,
        warnings=warnings,
    )


def _render_pdf_page(source_path: Path, render_dpi: int) -> tuple[np.ndarray, float]:
    scale = render_dpi / 72.0
    with fitz.open(source_path) as document:
        page = document[0]
        pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
    image: np.ndarray = np.frombuffer(pixmap.samples, dtype=np.uint8).reshape(
        pixmap.height,
        pixmap.width,
        pixmap.n,
    )
    if pixmap.n == 1:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
    return image, scale


def _candidate_polygon(candidate: CandidateRegion) -> Polygon:
    polygon = Polygon(candidate.polygon_pdf).buffer(0)
    if isinstance(polygon, Polygon):
        return polygon
    if isinstance(polygon, MultiPolygon):
        return max(polygon.geoms, key=lambda geom: geom.area)
    return Polygon()


def _polygon_mask(polygon: Polygon, image_shape: tuple[int, int], scale: float) -> np.ndarray:
    mask = np.zeros(image_shape, dtype=np.uint8)
    points = np.array(
        [[round(x * scale), round(y * scale)] for x, y in polygon.exterior.coords[:-1]],
        dtype=np.int32,
    )
    if len(points) >= 3:
        cv2.fillPoly(mask, [points], 255)
    return mask


def _semantic_exclusion_mask(
    *,
    semantic_zones: Sequence[SemanticZone],
    image_shape: tuple[int, int],
    scale: float,
    page_width: float,
    page_height: float,
    candidate_polygon: Polygon,
) -> np.ndarray:
    mask = np.zeros(image_shape, dtype=np.uint8)
    for zone in semantic_zones:
        if not zone.excluded:
            continue
        exclusion_box = _expanded_zone_box(zone, page_width, page_height, candidate_polygon)
        if not candidate_polygon.buffer(80).intersects(exclusion_box):
            continue
        x0, y0, x1, y1 = exclusion_box.bounds
        top_left = (round(x0 * scale), round(y0 * scale))
        bottom_right = (round(x1 * scale), round(y1 * scale))
        cv2.rectangle(mask, top_left, bottom_right, 255, thickness=-1)
    return mask


def _expanded_zone_box(
    zone: SemanticZone,
    page_width: float,
    page_height: float,
    candidate_polygon: Polygon,
) -> Polygon:
    x0, y0, x1, y1 = zone.bbox_pdf
    padding_by_type = {
        "title_block": 30.0,
        "legend": 45.0,
        "notes": 35.0,
        "pv_array": 180.0,
        "existing_roof": 170.0,
        "pitched_roof": 220.0,
        "plant_zone": 160.0,
        "non_target_roof": 260.0,
    }
    padding = padding_by_type.get(zone.type, 80.0)
    expanded = box(
        max(0.0, x0 - padding),
        max(0.0, y0 - padding),
        min(page_width, x1 + padding),
        min(page_height, y1 + padding),
    )
    if zone.type in {"pitched_roof", "non_target_roof"}:
        candidate_min_x, _, _, _ = candidate_polygon.bounds
        zone_center_x = (x0 + x1) / 2
        if zone_center_x <= candidate_polygon.centroid.x:
            expanded = expanded.union(
                box(
                    max(0.0, min(candidate_min_x, x0 - padding)),
                    max(0.0, y0 - padding),
                    min(page_width, x1 + padding * 1.8),
                    min(page_height, y1 + padding),
                )
            )
    if isinstance(expanded, Polygon):
        return expanded
    polygons = [geom for geom in expanded.geoms if isinstance(geom, Polygon)]
    return max(polygons, key=lambda geom: geom.area) if polygons else box(x0, y0, x1, y1)


def _clean_mask(mask: np.ndarray) -> np.ndarray:
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (11, 11))
    open_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    cleaned = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, close_kernel, iterations=1)
    cleaned = cv2.morphologyEx(cleaned, cv2.MORPH_OPEN, open_kernel, iterations=1)
    flood = cleaned.copy()
    flood_mask = np.zeros((cleaned.shape[0] + 2, cleaned.shape[1] + 2), dtype=np.uint8)
    cv2.floodFill(flood, flood_mask, (0, 0), 255)
    holes = cv2.bitwise_not(flood)
    return cv2.bitwise_or(cleaned, holes)


def _linework_mask(image: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_RGB2GRAY)
    binary = cv2.adaptiveThreshold(
        gray,
        255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV,
        blockSize=31,
        C=10,
    )
    small_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (7, 7))
    binary = cv2.morphologyEx(binary, cv2.MORPH_OPEN, small_kernel, iterations=1)
    return cv2.morphologyEx(binary, cv2.MORPH_CLOSE, close_kernel, iterations=1)


def _boundary_band(mask: np.ndarray) -> np.ndarray:
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (13, 13))
    dilated = cv2.dilate(mask, kernel, iterations=1)
    eroded = cv2.erode(mask, kernel, iterations=1)
    return cv2.subtract(dilated, eroded)


def _boundary_support_ratio(linework_mask: np.ndarray, boundary_band: np.ndarray) -> float:
    band_pixels = max(int(cv2.countNonZero(boundary_band)), 1)
    supported = cv2.bitwise_and(linework_mask, linework_mask, mask=boundary_band)
    return round(min(1.0, int(cv2.countNonZero(supported)) / band_pixels * 8.0), 4)


def _best_contour_polygon(
    *,
    refined_mask: np.ndarray,
    scale: float,
    anchors: list[Point],
    original_polygon: Polygon,
) -> Polygon | None:
    contours, _ = cv2.findContours(refined_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best_polygon: Polygon | None = None
    best_score = -1.0
    for contour in contours:
        if cv2.contourArea(contour) < 250:
            continue
        epsilon = max(2.0, 0.006 * cv2.arcLength(contour, True))
        approx = cv2.approxPolyDP(contour, epsilon, True)
        points = [(float(point[0][0]) / scale, float(point[0][1]) / scale) for point in approx]
        if len(points) < 3:
            continue
        polygon = Polygon(points).buffer(0)
        if not isinstance(polygon, Polygon) or polygon.is_empty:
            continue
        retention = _anchor_retention(polygon, anchors)
        area_ratio = min(1.0, float(polygon.area) / max(float(original_polygon.area), 1.0))
        score = retention * 0.75 + area_ratio * 0.25
        if score > best_score:
            best_score = score
            best_polygon = polygon
    return best_polygon


def _clean_polygon(polygon: Polygon) -> Polygon:
    cleaned = polygon.buffer(0)
    if not isinstance(cleaned, Polygon):
        polygons = [geom for geom in cleaned.geoms if isinstance(geom, Polygon)]
        cleaned = max(polygons, key=lambda geom: geom.area) if polygons else Polygon()
    cleaned = _remove_spike_vertices(cleaned, tolerance=4.0)
    cleaned = cleaned.simplify(1.0, preserve_topology=True).buffer(0)
    if isinstance(cleaned, Polygon):
        return cleaned
    if isinstance(cleaned, MultiPolygon):
        return max(cleaned.geoms, key=lambda geom: geom.area)
    return Polygon()


def _snap_polygon_to_vector_linework(polygon: Polygon, vector_document: VectorDocument) -> Polygon:
    if polygon.is_empty:
        return polygon
    horizontal, vertical = _axis_linework(vector_document)
    if not horizontal and not vertical:
        return polygon
    snapped_points: list[tuple[float, float]] = []
    for x, y in polygon.exterior.coords[:-1]:
        snapped_x = _nearest_supported_vertical(x, y, vertical)
        snapped_y = _nearest_supported_horizontal(x, y, horizontal)
        snapped_points.append(
            (
                snapped_x if snapped_x is not None else x,
                snapped_y if snapped_y is not None else y,
            )
        )
    snapped = Polygon(snapped_points).buffer(0)
    if not isinstance(snapped, Polygon) or snapped.is_empty or snapped.area <= 0:
        return polygon
    area_ratio = float(snapped.area) / max(float(polygon.area), 1.0)
    if 0.92 <= area_ratio <= 1.08:
        return _clean_polygon(snapped)
    return polygon


def _axis_linework(
    vector_document: VectorDocument,
) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
    horizontal: list[tuple[float, float, float]] = []
    vertical: list[tuple[float, float, float]] = []
    accepted_roles = {"roof_perimeter", "parapet_or_wall", "hatch", "unknown"}
    for primitive in vector_document.vector_primitives:
        if primitive.type != "line" or primitive.start_pdf is None or primitive.end_pdf is None:
            continue
        if primitive.semantic_role not in accepted_roles:
            continue
        start_x, start_y = primitive.start_pdf
        end_x, end_y = primitive.end_pdf
        dx = abs(start_x - end_x)
        dy = abs(start_y - end_y)
        if dx >= 30 and dy <= 2:
            horizontal.append(((start_y + end_y) / 2, min(start_x, end_x), max(start_x, end_x)))
        elif dy >= 30 and dx <= 2:
            vertical.append(((start_x + end_x) / 2, min(start_y, end_y), max(start_y, end_y)))
    return horizontal, vertical


def _nearest_supported_horizontal(
    x: float,
    y: float,
    horizontal: list[tuple[float, float, float]],
    *,
    tolerance: float = 6.0,
) -> float | None:
    candidates = [
        line_y
        for line_y, x0, x1 in horizontal
        if abs(line_y - y) <= tolerance and x0 - 8 <= x <= x1 + 8
    ]
    return min(candidates, key=lambda value: abs(value - y)) if candidates else None


def _nearest_supported_vertical(
    x: float,
    y: float,
    vertical: list[tuple[float, float, float]],
    *,
    tolerance: float = 6.0,
) -> float | None:
    candidates = [
        line_x
        for line_x, y0, y1 in vertical
        if abs(line_x - x) <= tolerance and y0 - 8 <= y <= y1 + 8
    ]
    return min(candidates, key=lambda value: abs(value - x)) if candidates else None


def _remove_spike_vertices(polygon: Polygon, *, tolerance: float) -> Polygon:
    coords = list(polygon.exterior.coords)[:-1]
    if len(coords) < 4:
        return polygon
    kept: list[tuple[float, float]] = []
    for index, point in enumerate(coords):
        previous = coords[index - 1]
        following = coords[(index + 1) % len(coords)]
        if Point(previous).distance(Point(following)) <= tolerance:
            continue
        kept.append((float(point[0]), float(point[1])))
    if len(kept) < 3:
        return polygon
    return Polygon(kept).buffer(0)


def _anchor_points(vector_document: VectorDocument, candidate_polygon: Polygon) -> list[Point]:
    anchors: list[Point] = []
    for block in vector_document.text_blocks:
        labels = _rwp_labels_in_text(block.text)
        if not labels:
            continue
        anchors.extend(_distributed_bbox_points(block.bbox_pdf, len(labels)))
    return [
        anchor
        for anchor in anchors
        if candidate_polygon.contains(anchor) or candidate_polygon.distance(anchor) <= 140
    ]


def _distributed_bbox_points(bbox: list[float], count: int) -> list[Point]:
    if count <= 1:
        return [_bbox_center(bbox)]
    y = (bbox[1] + bbox[3]) / 2
    width = bbox[2] - bbox[0]
    if width <= 0:
        return [_bbox_center(bbox) for _ in range(count)]
    step = width / (count + 1)
    return [Point(bbox[0] + step * (index + 1), y) for index in range(count)]


def _bbox_center(bbox: list[float]) -> Point:
    return Point((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


def _anchor_retention(polygon: Polygon, anchors: list[Point]) -> float:
    if not anchors:
        return 1.0
    retained = sum(
        1 for anchor in anchors if polygon.contains(anchor) or polygon.distance(anchor) <= 90
    )
    return round(retained / len(anchors), 4)


def _axis_aligned_edge_ratio(polygon: Polygon) -> float:
    coords = list(polygon.exterior.coords)
    if len(coords) < 2:
        return 0.0
    edges = list(zip(coords, coords[1:], strict=False))
    if not edges:
        return 0.0
    aligned = 0
    for start, end in edges:
        dx = abs(end[0] - start[0])
        dy = abs(end[1] - start[1])
        if dx <= 2.0 or dy <= 2.0:
            aligned += 1
    return round(aligned / len(edges), 4)


def _refinement_warnings(
    *,
    candidate_polygon: Polygon,
    refined_polygon: Polygon,
    metrics: OpenCvRefinementMetrics,
    anchors: list[Point],
) -> list[str]:
    warnings: list[str] = []
    if not refined_polygon.is_valid:
        warnings.append("refined_polygon_invalid")
    area_ratio = float(refined_polygon.area) / max(float(candidate_polygon.area), 1.0)
    if area_ratio < MIN_REFINED_AREA_RATIO:
        warnings.append("refined_area_too_small")
    if area_ratio > MAX_REFINED_AREA_RATIO:
        warnings.append("refined_area_too_large")
    if anchors and metrics.semantic_anchor_retention < MIN_ANCHOR_RETENTION:
        warnings.append("refined_polygon_lost_semantic_anchors")
    if metrics.boundary_support_ratio < 0.35:
        warnings.append("opencv_boundary_support_low")
    if metrics.excluded_region_removed_area_ratio > 0.20:
        warnings.append("opencv_exclusion_subtraction_requires_review")
    if metrics.area_change_ratio > 0.35:
        warnings.append("opencv_area_change_requires_review")
    return warnings


def _polygon_points(polygon: Polygon) -> list[list[float]]:
    return [[round(float(x), 3), round(float(y), 3)] for x, y in polygon.exterior.coords[:-1]]


def _rejected(candidate_id: str, warning: str) -> RefinedCandidateResult:
    return RefinedCandidateResult(
        accepted=False,
        source_candidate_id=candidate_id,
        polygon_pdf=[],
        warnings=[warning],
    )
