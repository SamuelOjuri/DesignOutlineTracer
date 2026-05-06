from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np
from shapely.geometry import Polygon, box

from app.models.raster import (
    RasterRenderResult,
    RasterSheetRegion,
    RasterTextBlock,
    SegmentationCandidate,
)

ER_BOX_SOURCE = "gemini_er_box_region"
ER_REFINED_SOURCE = "gemini_er_linework_refined_region"
EXCLUDED_SHEET_REGION_TYPES = {
    "title_block",
    "legend",
    "notes",
    "revision_table",
    "scale_bar_region",
}


@dataclass(frozen=True)
class _Crop:
    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width(self) -> int:
        return self.x1 - self.x0

    @property
    def height(self) -> int:
        return self.y1 - self.y0


def refine_er_segmentation_candidates(
    *,
    segmentation_candidates: list[SegmentationCandidate],
    linework_path: Path,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    sheet_regions: list[RasterSheetRegion],
    debug_dir: Path,
) -> list[SegmentationCandidate]:
    """Append linework-refined candidates for Gemini ER box proposals.

    Gemini ER box-only output is a semantic locator. This stage uses the box as
    a padded crop/seed, floods the bounded white space against enhanced CAD
    linework, and returns the traced polygon as a higher-priority candidate.
    The original ER candidate is kept so the audit trail remains visible.
    """
    if not segmentation_candidates:
        return []

    linework = cv2.imread(str(linework_path), cv2.IMREAD_GRAYSCALE)
    if linework is None:
        return segmentation_candidates

    debug_dir.mkdir(parents=True, exist_ok=True)
    refined_candidates: list[SegmentationCandidate] = []
    audits: list[dict[str, object]] = []

    for candidate in segmentation_candidates:
        refined, audit = _refine_one_candidate(
            candidate=candidate,
            linework=linework,
            render_result=render_result,
            text_blocks=text_blocks,
            sheet_regions=sheet_regions,
            debug_dir=debug_dir,
            debug_index=len(audits) + 1,
        )
        audits.append(audit)
        if refined is not None:
            refined_candidates.append(refined)
        refined_candidates.append(candidate)

    (debug_dir / "er_refinement_audit.json").write_text(
        json.dumps(audits, indent=2),
        encoding="utf-8",
    )
    return refined_candidates


def _refine_one_candidate(
    *,
    candidate: SegmentationCandidate,
    linework: np.ndarray,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
    sheet_regions: list[RasterSheetRegion],
    debug_dir: Path,
    debug_index: int,
) -> tuple[SegmentationCandidate | None, dict[str, object]]:
    audit: dict[str, object] = {
        "candidate_id": candidate.id,
        "source": candidate.source,
        "refined": False,
    }
    if candidate.provider != "gemini_er" or candidate.source != ER_BOX_SOURCE:
        audit["reason"] = "not_gemini_er_box_region"
        return None, audit

    crop = _expanded_crop(candidate.bbox_px, render_result, sheet_regions)
    if crop.width <= 8 or crop.height <= 8:
        audit["reason"] = "empty_crop"
        return None, audit

    crop_image = linework[crop.y0 : crop.y1, crop.x0 : crop.x1]
    crop_image = _mask_excluded_regions(crop_image.copy(), crop, sheet_regions)
    _write_crop_debug(crop_image, debug_dir, debug_index)

    wall_mask = _wall_mask(crop_image)
    if int(np.count_nonzero(wall_mask)) < 16:
        audit["reason"] = "no_linework_in_crop"
        return None, audit

    seed = _seed_point(candidate, crop)
    seed = _nearest_free_seed(wall_mask, seed)
    if seed is None:
        audit["reason"] = "no_free_seed"
        return None, audit

    flood_mask = _flood_fill_region(wall_mask, seed)
    cv2.imwrite(str(_debug_path(debug_dir, "er_flood_fill_mask", debug_index)), flood_mask)
    polygon = _polygon_from_flood_mask(flood_mask, crop, wall_mask)
    if polygon is None:
        audit["reason"] = "no_closed_flood_region"
        return None, audit

    polygon = _snap_polygon_to_linework(polygon, wall_mask, crop)
    polygon = _repair_polygon(polygon)
    if polygon is None:
        audit["reason"] = "invalid_refined_polygon"
        return None, audit

    score = _refinement_score(polygon, candidate, render_result, text_blocks)
    audit.update(
        {
            "refined": score >= 0.52,
            "score": round(score, 4),
            "polygon_area_px": round(float(polygon.area), 3),
            "vertex_count": len(list(polygon.exterior.coords)) - 1,
        }
    )
    if score < 0.52:
        audit["reason"] = "low_refinement_score"
        return None, audit

    _write_overlay_debug(linework, candidate, polygon, debug_dir, debug_index)
    polygon_points = [
        [round(float(x), 3), round(float(y), 3)]
        for x, y in polygon.exterior.coords[:-1]
    ]
    return (
        SegmentationCandidate(
            id=f"{candidate.id}_linework_refined",
            source=ER_REFINED_SOURCE,
            provider="gemini_er",
            prompt=candidate.prompt,
            label=candidate.label,
            bbox_px=[round(float(value), 3) for value in polygon.bounds],
            polygon_px=polygon_points,
            mask_area_px=round(float(polygon.area), 3),
            geometry_confidence=round(max(candidate.geometry_confidence, min(0.86, score)), 3),
            semantic_confidence=candidate.semantic_confidence,
            review_required=True,
        ),
        audit,
    )


def _expanded_crop(
    bbox_px: list[float],
    render_result: RasterRenderResult,
    sheet_regions: list[RasterSheetRegion],
) -> _Crop:
    x0, y0, x1, y1 = bbox_px
    width = max(1.0, x1 - x0)
    height = max(1.0, y1 - y0)
    pad = max(24.0, max(width, height) * 0.12)
    viewport = _drawing_viewport(render_result, sheet_regions)
    return _Crop(
        x0=max(viewport.x0, int(np.floor(x0 - pad))),
        y0=max(viewport.y0, int(np.floor(y0 - pad))),
        x1=min(viewport.x1, int(np.ceil(x1 + pad))),
        y1=min(viewport.y1, int(np.ceil(y1 + pad))),
    )


def _drawing_viewport(
    render_result: RasterRenderResult,
    sheet_regions: list[RasterSheetRegion],
) -> _Crop:
    viewport = next((region for region in sheet_regions if region.type == "drawing_viewport"), None)
    if viewport is not None:
        x0, y0, x1, y1 = viewport.bbox_px
        return _Crop(x0, y0, x1, y1)
    x0, y0, x1, y1 = render_result.viewport_bbox_px
    return _Crop(x0, y0, x1, y1)


def _mask_excluded_regions(
    crop_image: np.ndarray,
    crop: _Crop,
    sheet_regions: list[RasterSheetRegion],
) -> np.ndarray:
    for region in sheet_regions:
        if region.type not in EXCLUDED_SHEET_REGION_TYPES:
            continue
        region_box = box(*region.bbox_px)
        crop_box = box(crop.x0, crop.y0, crop.x1, crop.y1)
        overlap = region_box.intersection(crop_box)
        if overlap.is_empty:
            continue
        x0, y0, x1, y1 = [int(round(value)) for value in overlap.bounds]
        crop_image[y0 - crop.y0 : y1 - crop.y0, x0 - crop.x0 : x1 - crop.x0] = 0
    return crop_image


def _wall_mask(crop_image: np.ndarray) -> np.ndarray:
    _, threshold = cv2.threshold(crop_image, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    if np.count_nonzero(threshold) > threshold.size * 0.65:
        threshold = cv2.bitwise_not(threshold)
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(threshold, cv2.MORPH_CLOSE, kernel, iterations=2)
    return cv2.dilate(closed, np.ones((3, 3), np.uint8), iterations=1)


def _seed_point(candidate: SegmentationCandidate, crop: _Crop) -> tuple[int, int]:
    if candidate.point_px is not None:
        x_value, y_value = candidate.point_px
    else:
        x_value = (candidate.bbox_px[0] + candidate.bbox_px[2]) / 2
        y_value = (candidate.bbox_px[1] + candidate.bbox_px[3]) / 2
    return (
        int(np.clip(round(x_value - crop.x0), 0, crop.width - 1)),
        int(np.clip(round(y_value - crop.y0), 0, crop.height - 1)),
    )


def _nearest_free_seed(wall_mask: np.ndarray, seed: tuple[int, int]) -> tuple[int, int] | None:
    x_seed, y_seed = seed
    if wall_mask[y_seed, x_seed] == 0:
        return seed
    free_pixels = np.column_stack(np.where(wall_mask == 0))
    if free_pixels.size == 0:
        return None
    distances = (free_pixels[:, 1] - x_seed) ** 2 + (free_pixels[:, 0] - y_seed) ** 2
    y_value, x_value = free_pixels[int(np.argmin(distances))]
    return int(x_value), int(y_value)


def _flood_fill_region(wall_mask: np.ndarray, seed: tuple[int, int]) -> np.ndarray:
    free = np.where(wall_mask > 0, 0, 255).astype(np.uint8)
    fill_source = free.copy()
    flood_mask = np.zeros((free.shape[0] + 2, free.shape[1] + 2), np.uint8)
    cv2.floodFill(fill_source, flood_mask, seed, 128)
    return np.where(fill_source == 128, 255, 0).astype(np.uint8)


def _polygon_from_flood_mask(
    flood_mask: np.ndarray,
    crop: _Crop,
    wall_mask: np.ndarray,
) -> Polygon | None:
    filled_area = float(np.count_nonzero(flood_mask))
    if filled_area < 64 or filled_area > flood_mask.size * 0.92:
        return None
    contours, _ = cv2.findContours(flood_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None
    contour = max(contours, key=cv2.contourArea)
    if cv2.contourArea(contour) < 64:
        return None
    epsilon = max(2.0, min(wall_mask.shape) * 0.004)
    approx = cv2.approxPolyDP(contour, epsilon, True)
    points = [
        (float(point[0][0] + crop.x0), float(point[0][1] + crop.y0))
        for point in approx
    ]
    if len(points) < 3:
        return None
    return Polygon(points)


def _snap_polygon_to_linework(polygon: Polygon, wall_mask: np.ndarray, crop: _Crop) -> Polygon:
    horizontal_lines, vertical_lines = _dominant_axis_lines(wall_mask, crop)
    snapped_points: list[tuple[float, float]] = []
    for x_value, y_value in list(polygon.exterior.coords)[:-1]:
        snapped_x = _nearest_axis_value(x_value, vertical_lines, tolerance=8.0)
        snapped_y = _nearest_axis_value(y_value, horizontal_lines, tolerance=8.0)
        snapped_points.append((snapped_x, snapped_y))
    snapped_points = _remove_redundant_points(snapped_points)
    if len(snapped_points) < 3:
        return polygon
    return Polygon(snapped_points)


def _dominant_axis_lines(wall_mask: np.ndarray, crop: _Crop) -> tuple[list[float], list[float]]:
    lines = cv2.HoughLinesP(
        wall_mask,
        1,
        np.pi / 180,
        threshold=45,
        minLineLength=40,
        maxLineGap=10,
    )
    horizontal: list[float] = []
    vertical: list[float] = []
    if lines is None:
        return horizontal, vertical
    for line in lines[:, 0, :]:
        x0, y0, x1, y1 = [int(value) for value in line]
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        if dx >= max(24, dy * 4):
            horizontal.append(crop.y0 + (y0 + y1) / 2)
        elif dy >= max(24, dx * 4):
            vertical.append(crop.x0 + (x0 + x1) / 2)
    return _cluster_axis_values(horizontal), _cluster_axis_values(vertical)


def _cluster_axis_values(values: list[float], tolerance: float = 6.0) -> list[float]:
    if not values:
        return []
    values = sorted(values)
    clusters: list[list[float]] = [[values[0]]]
    for value in values[1:]:
        if abs(value - np.mean(clusters[-1])) <= tolerance:
            clusters[-1].append(value)
        else:
            clusters.append([value])
    return [float(np.mean(cluster)) for cluster in clusters]


def _nearest_axis_value(value: float, axis_values: list[float], tolerance: float) -> float:
    if not axis_values:
        return float(value)
    nearest = min(axis_values, key=lambda axis_value: abs(axis_value - value))
    if abs(nearest - value) <= tolerance:
        return float(round(nearest, 3))
    return float(value)


def _remove_redundant_points(points: list[tuple[float, float]]) -> list[tuple[float, float]]:
    if len(points) < 4:
        return points
    deduped: list[tuple[float, float]] = []
    for point in points:
        if not deduped or _point_distance(deduped[-1], point) > 1.5:
            deduped.append(point)
    if len(deduped) > 1 and _point_distance(deduped[0], deduped[-1]) <= 1.5:
        deduped.pop()
    changed = True
    while changed and len(deduped) >= 4:
        changed = False
        simplified: list[tuple[float, float]] = []
        for index, point in enumerate(deduped):
            previous = deduped[index - 1]
            nxt = deduped[(index + 1) % len(deduped)]
            if _is_collinear(previous, point, nxt):
                changed = True
                continue
            simplified.append(point)
        deduped = simplified
    return deduped


def _point_distance(a: tuple[float, float], b: tuple[float, float]) -> float:
    return float(((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5)


def _is_collinear(
    previous: tuple[float, float],
    point: tuple[float, float],
    nxt: tuple[float, float],
    tolerance: float = 2.0,
) -> bool:
    return (
        abs(previous[0] - point[0]) <= tolerance and abs(point[0] - nxt[0]) <= tolerance
    ) or (
        abs(previous[1] - point[1]) <= tolerance and abs(point[1] - nxt[1]) <= tolerance
    )


def _repair_polygon(polygon: Polygon) -> Polygon | None:
    if polygon.is_empty or polygon.area <= 0:
        return None
    if not polygon.is_valid:
        repaired = polygon.buffer(0)
        if not isinstance(repaired, Polygon) or repaired.is_empty:
            return None
        polygon = repaired
    if len(list(polygon.exterior.coords)) < 4:
        return None
    return polygon


def _refinement_score(
    polygon: Polygon,
    candidate: SegmentationCandidate,
    render_result: RasterRenderResult,
    text_blocks: list[RasterTextBlock],
) -> float:
    candidate_box = box(*candidate.bbox_px)
    overlap_ratio = 0.0
    if polygon.area > 0:
        overlap_ratio = polygon.intersection(candidate_box).area / polygon.area
    bbox_area = candidate_box.area
    area_ratio = polygon.area / bbox_area if bbox_area else 0.0
    page_area = render_result.render.width_px * render_result.render.height_px
    plausible_area = 0.001 <= (polygon.area / page_area) <= 0.75 if page_area else False
    text_support = any(_block_intersects_polygon(block, polygon) for block in text_blocks)
    vertex_bonus = 0.12 if len(list(polygon.exterior.coords)) - 1 > 4 else 0.0
    score = 0.0
    score += min(0.35, overlap_ratio * 0.35)
    score += 0.22 if 0.20 <= area_ratio <= 1.20 else 0.08
    score += 0.18 if plausible_area else 0.0
    score += 0.13 if text_support or not text_blocks else 0.04
    score += vertex_bonus
    return float(min(1.0, score))


def _block_intersects_polygon(block: RasterTextBlock, polygon: Polygon) -> bool:
    return polygon.intersects(box(*block.bbox_px))


def _write_crop_debug(crop_image: np.ndarray, debug_dir: Path, debug_index: int) -> None:
    cv2.imwrite(str(_debug_path(debug_dir, "er_linework_crop", debug_index)), crop_image)


def _write_overlay_debug(
    linework: np.ndarray,
    candidate: SegmentationCandidate,
    polygon: Polygon,
    debug_dir: Path,
    debug_index: int,
) -> None:
    overlay = cv2.cvtColor(linework, cv2.COLOR_GRAY2BGR)
    x0, y0, x1, y1 = [int(round(value)) for value in candidate.bbox_px]
    cv2.rectangle(overlay, (x0, y0), (x1, y1), (0, 165, 255), 3)
    cv2.imwrite(str(_debug_path(debug_dir, "er_seed_box_overlay", debug_index)), overlay)

    refined_overlay = overlay.copy()
    points = np.array(
        [[int(round(x)), int(round(y))] for x, y in polygon.exterior.coords[:-1]],
        dtype=np.int32,
    )
    cv2.polylines(refined_overlay, [points], True, (255, 0, 0), 4)
    cv2.imwrite(
        str(_debug_path(debug_dir, "er_refined_polygon_overlay", debug_index)),
        refined_overlay,
    )


def _debug_path(debug_dir: Path, stem: str, debug_index: int) -> Path:
    if debug_index == 1:
        return debug_dir / f"{stem}.png"
    return debug_dir / f"{stem}_{debug_index:02d}.png"
