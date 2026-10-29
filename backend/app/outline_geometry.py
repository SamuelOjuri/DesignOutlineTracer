"""Conservative source-supported fitting of exterior insulation-scope polygons.

The model decides which surface is wanted. This module only moves a proposed
edge when nearby drawing evidence supports it, and never fills a bounding box,
dilates a mask, invents holes, or repairs invalid topology silently.
"""

from dataclasses import dataclass
from io import BytesIO
import math
from typing import Sequence

from PIL import Image

from .errors import RoiError


ALGORITHM_VERSION = "source-supported-outline-v1"
MAX_POLYGONS = 8
MAX_POINTS = 128
EPS = 1e-7


@dataclass(frozen=True)
class PreparedOutlineCrop:
    png: bytes
    crop: dict
    source_width: int
    source_height: int


def _rgb(data: bytes) -> Image.Image:
    with Image.open(BytesIO(data)) as source:
        rgba = source.convert("RGBA")
        white = Image.new("RGBA", rgba.size, "white")
        white.alpha_composite(rgba)
        return white.convert("RGB")


def _number(value) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RoiError("invalid_outline_geometry", 502)
    return float(value)


def _bounds(box: Sequence[float], width: int, height: int) -> tuple[float, float, float, float]:
    if len(box) != 4:
        raise RoiError("invalid_outline_geometry", 502)
    ymin, xmin, ymax, xmax = [_number(v) for v in box]
    if not (0 <= xmin < xmax <= 1000 and 0 <= ymin < ymax <= 1000):
        raise RoiError("invalid_outline_geometry", 502)
    return xmin * width / 1000, ymin * height / 1000, xmax * width / 1000, ymax * height / 1000


def prepare_outline_crop(original: bytes, box: Sequence[float], max_side: int = 2048,
                         padding_fraction: float = .06) -> PreparedOutlineCrop:
    """Crop ORIGINAL page pixels, with context, before any inference downsampling."""
    if not 256 <= max_side <= 4096 or not 0 <= padding_fraction <= .25:
        raise ValueError("invalid_outline_preparation_settings")
    rgb = _rgb(original)
    width, height = rgb.size
    left, top, right, bottom = _bounds(box, width, height)
    padding = max(4, max(right - left, bottom - top) * padding_fraction)
    x, y = max(0, math.floor(left - padding)), max(0, math.floor(top - padding))
    x2, y2 = min(width, math.ceil(right + padding)), min(height, math.ceil(bottom + padding))
    crop = rgb.crop((x, y, x2, y2))
    crop.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    output = BytesIO()
    crop.save(output, format="PNG")
    return PreparedOutlineCrop(output.getvalue(), {
        "x": x, "y": y, "width": x2 - x, "height": y2 - y,
        "inference_width": crop.width, "inference_height": crop.height,
    }, width, height)


def _cross(a, b, c) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _distance(a, b) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _area(points) -> float:
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(points, points[1:] + points[:1])) / 2


def _on_segment(p, a, b) -> bool:
    return abs(_cross(a, b, p)) <= EPS * max(1, _distance(a, b)) and (
        min(a[0], b[0]) - EPS <= p[0] <= max(a[0], b[0]) + EPS
        and min(a[1], b[1]) - EPS <= p[1] <= max(a[1], b[1]) + EPS)


def _intersects(a, b, c, d) -> bool:
    ab_c, ab_d, cd_a, cd_b = _cross(a, b, c), _cross(a, b, d), _cross(c, d, a), _cross(c, d, b)
    return ((ab_c > EPS and ab_d < -EPS or ab_c < -EPS and ab_d > EPS)
            and (cd_a > EPS and cd_b < -EPS or cd_a < -EPS and cd_b > EPS)) or any((
                _on_segment(c, a, b), _on_segment(d, a, b), _on_segment(a, c, d), _on_segment(b, c, d)))


def _inside(point, points) -> bool:
    inside = False
    for a, b in zip(points, points[1:] + points[:1]):
        if _on_segment(point, a, b):
            return True
        if (a[1] > point[1]) != (b[1] > point[1]):
            if point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]:
                inside = not inside
    return inside


def _valid_ring(points) -> bool:
    if len(points) < 3 or abs(_area(points)) < 1:
        return False
    size = len(points)
    for i, a in enumerate(points):
        b = points[(i + 1) % size]
        if _distance(a, b) < .1:
            return False
        # Adjacent edges may meet once, but cannot reverse over each other.
        c = points[(i + 2) % size]
        if abs(_cross(a, b, c)) <= EPS and (
                (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])) < 0:
            return False
        for j in range(i + 1, size):
            if j == i + 1 or (i == 0 and j == size - 1):
                continue
            if _intersects(a, b, points[j], points[(j + 1) % size]):
                return False
    return True


def _disjoint(rings) -> bool:
    for i, first in enumerate(rings):
        for second in rings[i + 1:]:
            if _inside(first[0], second) or _inside(second[0], first):
                return False
            for a, b in zip(first, first[1:] + first[:1]):
                for c, d in zip(second, second[1:] + second[:1]):
                    if _intersects(a, b, c, d):
                        return False
    return True


def _simplify(points):
    """Remove exact/near-exact collinear redundancy without deleting returns."""
    result = list(points)
    changed = True
    while changed and len(result) > 3:
        changed = False
        for i, point in enumerate(result):
            before, after = result[i - 1], result[(i + 1) % len(result)]
            span = _distance(before, after)
            if span > .1 and abs(_cross(before, after, point)) / span <= .05 and (
                    (point[0] - before[0]) * (after[0] - point[0])
                    + (point[1] - before[1]) * (after[1] - point[1])) >= 0:
                result.pop(i)
                changed = True
                break
    return result


def _line(a, b):
    length = _distance(a, b)
    direction = ((b[0] - a[0]) / length, (b[1] - a[1]) / length)
    normal = (-direction[1], direction[0])
    return direction, normal, normal[0] * a[0] + normal[1] * a[1]


def _union_length(intervals):
    end, length = -math.inf, 0.
    for start, stop in sorted(intervals):
        if stop > max(start, end):
            length += stop - max(start, end)
        end = max(end, stop)
    return length


def _vector_candidates(a, b, segments, max_shift):
    direction, normal, offset = _line(a, b)
    length = _distance(a, b)
    groups = []
    for start, end in segments:
        if _distance(start, end) < 1:
            continue
        other_direction, other_normal, other_offset = _line(start, end)
        dot = direction[0] * other_direction[0] + direction[1] * other_direction[1]
        if abs(dot) < math.cos(math.radians(6)):
            continue
        if dot < 0:
            other_direction = (-other_direction[0], -other_direction[1])
            other_normal = (-other_normal[0], -other_normal[1])
            other_offset = -other_offset
        displacement = max(abs(other_normal[0] * p[0] + other_normal[1] * p[1] - other_offset) for p in (a, b))
        if displacement > max_shift:
            continue
        projected = [(p[0] - a[0]) * direction[0] + (p[1] - a[1]) * direction[1] for p in (start, end)]
        interval = max(0., min(projected)), min(length, max(projected))
        if interval[1] <= interval[0]:
            continue
        for group in groups:
            # Merge only fragments on the same drawn supporting line.
            if (abs(group["normal"][0] * start[0] + group["normal"][1] * start[1] - group["offset"]) < .5
                    and abs(group["normal"][0] * end[0] + group["normal"][1] * end[1] - group["offset"]) < .5):
                group["intervals"].append(interval)
                break
        else:
            groups.append({"normal": other_normal, "offset": other_offset, "intervals": [interval],
                           "displacement": displacement})
    result = []
    for group in groups:
        support = min(1., _union_length(group["intervals"]) / length)
        if support >= .45:
            result.append({**group, "support": support, "source": "vector",
                           "score": support - .18 * group["displacement"] / max_shift})
    return result


def _raster_support(a, b, normal, offset, pixels, width, height):
    # Project original endpoints onto this candidate line; signs are irrelevant.
    p = [(a[0] - normal[0] * (normal[0] * a[0] + normal[1] * a[1] - offset),
          a[1] - normal[1] * (normal[0] * a[0] + normal[1] * a[1] - offset)),
         (b[0] - normal[0] * (normal[0] * b[0] + normal[1] * b[1] - offset),
          b[1] - normal[1] * (normal[0] * b[0] + normal[1] * b[1] - offset))]
    samples = min(192, max(12, math.ceil(_distance(a, b) / 2)))
    supported = 0
    for i in range(samples):
        t = (i + .5) / samples
        x, y = p[0][0] + (p[1][0] - p[0][0]) * t, p[0][1] + (p[1][1] - p[0][1]) * t
        values = []
        for distance in (0, -3, 3):
            px, py = round(x + normal[0] * distance), round(y + normal[1] * distance)
            values.append(pixels[px, py] if 0 <= px < width and 0 <= py < height else 255)
        # Contrast on at least one side supports roof edges beside shaded roofs.
        # A uniform dark fill does not qualify as a drawn boundary.
        if values[0] <= 238 and max(values[1:]) - values[0] >= 12:
            supported += 1
    return supported / samples


def _dominant_direction(points):
    # Fourfold circular mean preserves a rotated building's orthogonal axes.
    cx = cy = total = 0.
    for a, b in zip(points, points[1:] + points[:1]):
        length = _distance(a, b)
        angle = math.atan2(b[1] - a[1], b[0] - a[0])
        cx += length * math.cos(4 * angle)
        cy += length * math.sin(4 * angle)
        total += length
    return math.atan2(cy, cx) / 4 if math.hypot(cx, cy) / total >= .9 else None


def _raster_candidates(a, b, pixels, width, height, max_shift, dominant):
    direction, normal, offset = _line(a, b)
    orientations = [normal]
    if dominant is not None:
        angle = math.atan2(direction[1], direction[0])
        target = dominant + round((angle - dominant) / (math.pi / 2)) * math.pi / 2
        if .001 < abs(target - angle) < math.radians(6):
            orientations.append((-math.sin(target), math.cos(target)))
    middle = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    result = []
    for candidate_normal in orientations:
        base = candidate_normal[0] * middle[0] + candidate_normal[1] * middle[1]
        for shift in range(-math.floor(max_shift), math.floor(max_shift) + 1):
            candidate_offset = base + shift
            displacement = max(abs(candidate_normal[0] * p[0] + candidate_normal[1] * p[1] - candidate_offset) for p in (a, b))
            if displacement > max_shift:
                continue
            support = _raster_support(a, b, candidate_normal, candidate_offset, pixels, width, height)
            if support >= .55:
                result.append({"normal": candidate_normal, "offset": candidate_offset, "support": support,
                               "source": "raster", "displacement": displacement,
                               "score": support - .18 * displacement / max_shift})
    return result


def _fit_ring(points, segments, pixels, width, height, bounds):
    left, top, right, bottom = bounds
    # Small, source-pixel search radius; never a percentage-wide roof expansion.
    max_shift = min(12., max(2., math.hypot(right - left, bottom - top) * .008))
    dominant = _dominant_direction(points)
    lines, evidence, warnings = [], [], []
    for index, (a, b) in enumerate(zip(points, points[1:] + points[:1])):
        _, normal, offset = _line(a, b)
        candidates = _vector_candidates(a, b, segments, max_shift)
        if not candidates:
            candidates = _raster_candidates(a, b, pixels, width, height, max_shift, dominant)
        candidates.sort(key=lambda candidate: (-candidate["score"], candidate["displacement"], candidate["offset"]))
        chosen = candidates[0] if candidates else None
        ambiguous = False
        if chosen:
            midpoint = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            # Distinct, similarly supported parallel lines are a semantic choice.
            # Keep the model edge and flag it instead of silently swapping faces.
            for other in candidates[1:]:
                separation = abs(other["normal"][0] * midpoint[0] + other["normal"][1] * midpoint[1] - other["offset"]
                                 - (chosen["normal"][0] * midpoint[0] + chosen["normal"][1] * midpoint[1] - chosen["offset"]))
                if separation > 2 and other["score"] >= chosen["score"] - .12:
                    ambiguous = True
                    break
        if chosen and not ambiguous:
            lines.append((chosen["normal"], chosen["offset"]))
            evidence.append({"index": index, "support": round(chosen["support"], 4),
                             "source": chosen["source"], "ambiguous": False})
            if chosen["support"] < .55:
                warnings.append("unsupported_boundary_segments")
        else:
            lines.append((normal, offset))
            support = _raster_support(a, b, normal, offset, pixels, width, height)
            evidence.append({"index": index, "support": round(support, 4),
                             "source": "raster" if support >= .55 else "unsupported", "ambiguous": ambiguous})
            warnings.append("ambiguous_parallel_edges" if ambiguous else "unsupported_boundary_segments")
    fitted = []
    for index, original in enumerate(points):
        (n1, c1), (n2, c2) = lines[index - 1], lines[index]
        det = n1[0] * n2[1] - n1[1] * n2[0]
        if abs(det) < .05:
            fitted.append(original)
        else:
            fitted.append(((c1 * n2[1] - n1[1] * c2) / det, (n1[0] * c2 - c1 * n2[0]) / det))
    # Geometry decisions are accepted or rejected for the entire ring.
    ratio = abs(_area(fitted)) / abs(_area(points))
    if (not _valid_ring(fitted) or _area(fitted) * _area(points) <= 0 or not .96 <= ratio <= 1.04
            or any(_distance(a, b) > max_shift * 1.6 for a, b in zip(points, fitted))
            or any(not left - EPS <= x <= right + EPS or not top - EPS <= y <= bottom + EPS for x, y in fitted)):
        fitted = points
        warnings.append("fitting_rejected")
        for edge, a, b in zip(evidence, points, points[1:] + points[:1]):
            _, n, c = _line(a, b)
            edge["support"] = round(_raster_support(a, b, n, c, pixels, width, height), 4)
            edge["source"] = "raster" if edge["support"] >= .55 else "unsupported"
    for a, b in zip(fitted, fitted[1:] + fitted[:1]):
        if any(abs(a[axis] - value) < .5 and abs(b[axis] - value) < .5
               for axis, value in ((0, left), (0, right), (1, top), (1, bottom))):
            warnings.append("roi_boundary_contact")
    return fitted, evidence, sorted(set(warnings))


def _serialize(points, bounds):
    # Preserve fractional source coordinates: rounding to six decimal places can
    # put a valid point outside a fractional ROI by more than the client epsilon.
    # Rings were already checked against these bounds. Clamp machine roundoff
    # only (at most EPS), never a meaningful out-of-scope part of the polygon.
    left, top, right, bottom = bounds
    return [{"x": min(right, max(left, x)), "y": min(bottom, max(top, y))} for x, y in points]


def refine_outline_polygons(original: bytes, box: Sequence[float], crop: dict,
                            polygons: list[list[dict]], vector_segments: list[dict] | None = None) -> dict:
    """Map crop-normalized proposals to the source page and conservatively fit.

    No proposal is returned for an ROI that excludes any part of the proposed
    scope. Invalid rings, nested rings (holes) and touching components are errors.
    Evidence scores measure line support, not semantic or construction confidence.
    """
    rgb = _rgb(original)
    width, height = rgb.size
    bounds = _bounds(box, width, height)
    if not isinstance(polygons, list) or len(polygons) > MAX_POLYGONS:
        raise RoiError("invalid_outline_geometry", 502)
    required = ("x", "y", "width", "height")
    if any(name not in crop for name in required):
        raise RoiError("invalid_outline_geometry", 502)
    x0, y0, cw, ch = [_number(crop[name]) for name in required]
    if cw <= 0 or ch <= 0 or x0 < 0 or y0 < 0 or x0 + cw > width or y0 + ch > height:
        raise RoiError("invalid_outline_geometry", 502)
    rings = []
    for polygon in polygons:
        if not isinstance(polygon, list) or not 3 <= len(polygon) <= MAX_POINTS:
            raise RoiError("invalid_outline_geometry", 502)
        ring = []
        for point in polygon:
            if not isinstance(point, dict) or set(point) != {"x", "y"}:
                raise RoiError("invalid_outline_geometry", 502)
            x, y = _number(point["x"]), _number(point["y"])
            if not 0 <= x <= 1000 or not 0 <= y <= 1000:
                raise RoiError("invalid_outline_geometry", 502)
            mapped = (x0 + x * cw / 1000, y0 + y * ch / 1000)
            if not ring or _distance(ring[-1], mapped) > EPS:
                ring.append(mapped)
        if len(ring) > 1 and _distance(ring[0], ring[-1]) <= EPS:
            ring.pop()
        if not _valid_ring(ring):
            raise RoiError("invalid_outline_geometry", 502)
        rings.append(_simplify(ring))
    if not _disjoint(rings):
        raise RoiError("invalid_outline_geometry", 502)
    left, top, right, bottom = bounds
    if any(not left - EPS <= x <= right + EPS or not top - EPS <= y <= bottom + EPS for ring in rings for x, y in ring):
        return {"status": "roi_too_tight", "proposals": [], "warnings": ["scope_outside_roi"]}
    segments = []
    if vector_segments is not None and (not isinstance(vector_segments, list) or len(vector_segments) > 2000):
        raise RoiError("invalid_outline_geometry", 502)
    for segment in vector_segments or []:
        if not isinstance(segment, dict) or set(segment) != {"start", "end"}:
            raise RoiError("invalid_outline_geometry", 502)
        endpoints = []
        for name in ("start", "end"):
            point = segment[name]
            if not isinstance(point, dict) or set(point) != {"x", "y"}:
                raise RoiError("invalid_outline_geometry", 502)
            x, y = _number(point["x"]), _number(point["y"])
            if not 0 <= x <= width or not 0 <= y <= height:
                raise RoiError("invalid_outline_geometry", 502)
            endpoints.append((x, y))
        if _distance(*endpoints) > .1:
            segments.append(endpoints)
    gray = rgb.convert("L")
    pixels = gray.load()
    fitted = [_fit_ring(ring, segments, pixels, width, height, bounds) for ring in rings]
    if not _disjoint([item[0] for item in fitted]):
        # Do not merge separate roofs as a side effect of source snapping.
        fitted = [(ring, [{"index": index, "support": 0., "source": "unsupported", "ambiguous": True}
                          for index in range(len(ring))], ["fitting_rejected", "component_conflict"])
                  for ring in rings]
    proposals = [{"points": _serialize(points, bounds), "proposed_points": _serialize(original_points, bounds),
                  "edges": edges, "warnings": warnings}
                 for original_points, (points, edges, warnings) in zip(rings, fitted)]
    warnings = sorted({warning for item in proposals for warning in item["warnings"]})
    return {"status": "no_outline" if not proposals else "needs_review" if warnings else "complete",
            "proposals": proposals, "warnings": warnings}
