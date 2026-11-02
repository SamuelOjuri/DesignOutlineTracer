"""Outline accuracy metrics. Coordinates are source-page pixels; nothing here calls a provider."""
from dataclasses import dataclass
import math

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union


def as_polygon(rings: list[list[tuple[float, float]]]) -> Polygon | MultiPolygon:
    parts = [Polygon(ring) for ring in rings if len(ring) >= 3]
    return unary_union([part if part.is_valid else part.buffer(0) for part in parts]) if parts else Polygon()


def _boundary(geometry) -> LineString:
    return geometry.boundary


def _sample(boundary, step: float) -> list:
    points = []
    lines = getattr(boundary, "geoms", [boundary])
    for line in lines:
        count = max(1, math.ceil(line.length / step))
        points.extend(line.interpolate(index * line.length / count) for index in range(count))
    return points


@dataclass(frozen=True)
class OutlineScore:
    iou: float
    area_error: float
    boundary_precision: dict[str, float]
    boundary_recall: dict[str, float]
    boundary_f1: dict[str, float]
    hausdorff: float
    mean_distance: float
    vertices: int

    def as_dict(self) -> dict:
        return {name: getattr(self, name) for name in self.__dataclass_fields__}


def score_outline(predicted: list[list[tuple[float, float]]], reference: list[list[tuple[float, float]]],
                  tolerances: tuple[float, ...] = (2., 5.), step: float = 1.) -> OutlineScore:
    """Region overlap plus boundary agreement within pixel tolerances (both directions)."""
    truth, guess = as_polygon(reference), as_polygon(predicted)
    if truth.is_empty:
        raise ValueError("empty_reference")
    if guess.is_empty:
        zero = {f"{tolerance:g}px": 0. for tolerance in tolerances}
        return OutlineScore(0., 1., zero, zero, zero, math.inf, math.inf, 0)
    union = truth.union(guess).area
    truth_line, guess_line = _boundary(truth), _boundary(guess)
    guess_samples, truth_samples = _sample(guess_line, step), _sample(truth_line, step)
    guess_distances = [truth_line.distance(point) for point in guess_samples]
    truth_distances = [guess_line.distance(point) for point in truth_samples]
    precision, recall, f1 = {}, {}, {}
    for tolerance in tolerances:
        key = f"{tolerance:g}px"
        precision[key] = sum(distance <= tolerance for distance in guess_distances) / len(guess_distances)
        recall[key] = sum(distance <= tolerance for distance in truth_distances) / len(truth_distances)
        total = precision[key] + recall[key]
        f1[key] = 0. if total == 0 else 2 * precision[key] * recall[key] / total
    return OutlineScore(
        iou=truth.intersection(guess).area / union if union else 0.,
        area_error=abs(guess.area - truth.area) / truth.area,
        boundary_precision=precision, boundary_recall=recall, boundary_f1=f1,
        hausdorff=max(max(guess_distances), max(truth_distances)),
        mean_distance=(sum(guess_distances) + sum(truth_distances)) / (len(guess_distances) + len(truth_distances)),
        vertices=sum(len(ring) for ring in predicted),
    )
