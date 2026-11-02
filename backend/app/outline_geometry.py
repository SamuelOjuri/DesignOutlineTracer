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


ALGORITHM_VERSION = "source-supported-outline-v6"
MAX_POLYGONS = 8
MAX_POINTS = 128
EPS = 1e-7
# Covers ordinary fitting (12 px + 3 px samples) and continuity side samples
# (8 px from candidate boundaries, which must stay within the ROI).
RASTER_MARGIN = 24


@dataclass(frozen=True)
class SourceRaster:
    """Grayscale page pixels around one ROI; reads outside it behave like the page edge."""
    gray: Image.Image
    origin: tuple[int, int]
    page_size: tuple[int, int]


@dataclass(frozen=True)
class PreparedOutlineCrop:
    png: bytes
    crop: dict
    source_width: int
    source_height: int
    source: SourceRaster | None = None


def _page_size(data: bytes) -> tuple[int, int]:
    with Image.open(BytesIO(data)) as source:
        return source.size


def _rgb(data: bytes, region: tuple[int, int, int, int] | None = None) -> Image.Image:
    """Decode once and flatten onto white; cropping first avoids converting the whole page."""
    with Image.open(BytesIO(data)) as source:
        image = source.crop(region) if region is not None else source
        rgba = image.convert("RGBA")
        white = Image.new("RGBA", rgba.size, "white")
        white.alpha_composite(rgba)
        return white.convert("RGB")


def _raster_region(bounds, width: int, height: int) -> tuple[int, int, int, int]:
    left, top, right, bottom = bounds
    return (max(0, math.floor(left) - RASTER_MARGIN), max(0, math.floor(top) - RASTER_MARGIN),
            min(width, math.ceil(right) + RASTER_MARGIN), min(height, math.ceil(bottom) + RASTER_MARGIN))


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
    width, height = _page_size(original)
    bounds = _bounds(box, width, height)
    left, top, right, bottom = bounds
    padding = max(4, max(right - left, bottom - top) * padding_fraction)
    x, y = max(0, math.floor(left - padding)), max(0, math.floor(top - padding))
    x2, y2 = min(width, math.ceil(right + padding)), min(height, math.ceil(bottom + padding))
    # One decode serves both the inference crop and the fitting pixels around the ROI.
    raster = _raster_region(bounds, width, height)
    region = min(x, raster[0]), min(y, raster[1]), max(x2, raster[2]), max(y2, raster[3])
    rgb = _rgb(original, region)
    crop = rgb.crop((x - region[0], y - region[1], x2 - region[0], y2 - region[1]))
    source = SourceRaster(rgb.convert("L"), (region[0], region[1]), (width, height))
    crop.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    output = BytesIO()
    crop.save(output, format="PNG")
    return PreparedOutlineCrop(output.getvalue(), {
        "x": x, "y": y, "width": x2 - x, "height": y2 - y,
        "inference_width": crop.width, "inference_height": crop.height,
    }, width, height, source)


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


def _max_shift(bounds) -> float:
    # Small, source-pixel search radius; never a percentage-wide roof expansion.
    left, top, right, bottom = bounds
    return min(12., max(2., math.hypot(right - left, bottom - top) * .008))


def _meet(a, b, c, d):
    """Intersection of lines ab and cd, or None unless they cross at 30 degrees or more."""
    first, second = (b[0] - a[0], b[1] - a[1]), (d[0] - c[0], d[1] - c[1])
    det = first[0] * second[1] - first[1] * second[0]
    if abs(det) < .5 * math.hypot(*first) * math.hypot(*second):
        return None
    t = ((c[0] - a[0]) * second[1] - (c[1] - a[1]) * second[0]) / det
    return a[0] + t * first[0], a[1] + t * first[1]


def _straighten_traced_sides(points, tolerance, bounds):
    """Remove near-collinear tracing bends adjoining a short corner run.

    Use the actual adjoining directions, not page axes. Compare every removal
    with the same starting ring so repeated simplification cannot drift a side.
    """
    result = list(points)
    while len(result) > 3:
        choices = []
        for index, point in enumerate(result):
            before, after = result[index - 1], result[(index + 1) % len(result)]
            # Do not simplify shallow bends elsewhere on the roof. One adjoining
            # side must actually end at a short transition that could hide a corner.
            if min(_distance(result[(index - 2) % len(result)], before),
                   _distance(after, result[(index + 2) % len(result)])) >= 2 * tolerance:
                continue
            first, _, _ = _line(before, point)
            second, _, _ = _line(point, after)
            span = _distance(before, after)
            if (sum(x * y for x, y in zip(first, second)) < math.cos(math.radians(6))
                    or span < 4 * tolerance or abs(_cross(before, after, point)) / span > tolerance):
                continue
            candidate = result[:index] + result[index + 1:]
            if _within_continuity_limits(candidate, points, bounds):
                choices.append((abs(_cross(before, after, point)) / span, point, candidate))
        if not choices:
            break
        result = min(choices, key=lambda item: (item[0], item[1]))[2]
    return result


def _collapse_corner_steps(points, tolerance, bounds):
    """Replace a bounded short curve/chamfer/jog with the adjoining sides' intersection.

    The model sometimes traces a wall nib or line offset at a corner as extra
    vertices. A short run may contain any number of curve samples; its total
    length, distance to the intersection and change to the original ring remain
    bounded. Straight offsets, larger returns and ROI violations are preserved.
    """
    left, top, right, bottom = bounds
    result = list(points)
    changed = True
    while changed:
        changed = False
        size = len(result)
        for start in range(size):
            for count in range(1, size - 2):
                run = [result[(start + k) % size] for k in range(count + 1)]
                before, after = result[start - 1], result[(start + count + 1) % size]
                lengths = [_distance(a, b) for a, b in zip(run, run[1:])]
                if max(lengths) >= tolerance or sum(lengths) > 3 * tolerance:
                    break
                if (_distance(before, run[0]) < 2 * tolerance or _distance(run[-1], after) < 2 * tolerance):
                    continue
                corner = _meet(before, run[0], run[-1], after)
                if (corner is None or any(_distance(corner, point) > 1.5 * tolerance for point in run)
                        or not (left - EPS <= corner[0] <= right + EPS and top - EPS <= corner[1] <= bottom + EPS)):
                    continue
                removed = {(start + k) % size for k in range(count + 1)}
                candidate = [corner if index == start else point
                             for index, point in enumerate(result) if index == start or index not in removed]
                if _within_continuity_limits(candidate, points, bounds):
                    result, changed = candidate, True
                    break
            if changed:
                break
    return result


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


def _raster_support(a, b, normal, offset, raster):
    pixels, (ox, oy), width, height = raster
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
            px, py = round(x + normal[0] * distance) - ox, round(y + normal[1] * distance) - oy
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


def _raster_candidates(a, b, raster, max_shift, dominant):
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
            support = _raster_support(a, b, candidate_normal, candidate_offset, raster)
            if support >= .55:
                result.append({"normal": candidate_normal, "offset": candidate_offset, "support": support,
                               "source": "raster", "displacement": displacement,
                               "score": support - .18 * displacement / max_shift})
    return result


def _side_contrast(a, b, normal, offset, raster, winding):
    """Outside minus inside ink in strips beside a line, with winding-independent signs."""
    pixels, (ox, oy), width, height = raster
    inside = outside = count = 0
    for index in range(96):
        t = .1 + .8 * (index + .5) / 96  # Avoid corners and their perpendicular strokes.
        x, y = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
        shift = normal[0] * x + normal[1] * y - offset
        x, y = x - normal[0] * shift, y - normal[1] * shift
        for depth in range(2, 9):
            values = []
            for sign in (winding, -winding):
                px, py = round(x + normal[0] * depth * sign) - ox, round(y + normal[1] * depth * sign) - oy
                if not (0 <= px < width and 0 <= py < height):
                    return None  # Missing pixels cannot establish which side is open roof.
                values.append(pixels[px, py] < 190)
            inside += values[0]
            outside += values[1]
            count += 1
    return (outside - inside) / count


def _point_to_ring_distance(point, ring):
    distances = []
    for a, b in zip(ring, ring[1:] + ring[:1]):
        dx, dy = b[0] - a[0], b[1] - a[1]
        t = min(1., max(0., ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)))
        distances.append(_distance(point, (a[0] + t * dx, a[1] + t * dy)))
    return min(distances)


def _within_continuity_limits(candidate, original, bounds):
    """Check total changes, including fitting after a repair that changes vertex count."""
    left, top, right, bottom = bounds
    return (_valid_ring(candidate) and .96 <= _area(candidate) / _area(original) <= 1.04
            and all(left - EPS <= x <= right + EPS and top - EPS <= y <= bottom + EPS for x, y in candidate)
            and all(_point_to_ring_distance(point, ring) <= 3 * _max_shift(bounds)
                    for points, ring in ((original, candidate), (candidate, original)) for point in points))


def _anchored_corner(corner, neighbour, normal, offset, segments, snap):
    """A drawn adjoining edge must meet the common line near the proposed corner.

    Checking the finite segments at their intersection excludes a nearby dimension
    line that merely parallels the perimeter without joining the roof corners.
    """
    tangent = (normal[1], -normal[0])
    on_line = (normal[0] * offset, normal[1] * offset)
    along = (on_line[0] + tangent[0], on_line[1] + tangent[1])
    options = _vector_candidates(neighbour, corner, segments, snap)
    for option in options:
        if option["support"] < .7:
            continue
        n, c = option["normal"], option["offset"]
        base = (n[0] * c, n[1] * c)
        meet = _meet(on_line, along, base, (base[0] + n[1], base[1] - n[0]))
        if meet is None or _distance(meet, corner) > snap:
            continue
        # Both finite lines must actually reach the intersection (allow antialias/roundoff gaps).
        def reaches(line_normal, line_offset):
            return any(abs(line_normal[0] * p[0] + line_normal[1] * p[1] - line_offset) < .5
                       and abs(line_normal[0] * q[0] + line_normal[1] * q[1] - line_offset) < .5
                       and _distance(p, meet) + _distance(meet, q) <= _distance(p, q) + 2
                       for p, q in segments)
        if reaches(normal, offset) and reaches(n, c):
            return True
    return False


def _repair_boundary_steps(points, segments, raster, bounds, policy):
    """Join a false face switch only with continuous, corner-anchored vector evidence.

    Raster-only or semantically ambiguous junctions stay editable and are flagged.
    The wider search is confined to this pattern; ordinary fitting keeps its radius.
    """
    snap = _max_shift(bounds)
    original_area = _area(points)
    winding = 1 if original_area > 0 else -1
    result, repaired_lines = list(points), []
    while True:
        uncertain = set()
        changed = False
        size = len(result)
        for index in range(size):
            # A--B and C--D are the long runs; B--C is the possible face switch.
            a, b, c, d = [result[(index + k) % size] for k in range(4)]
            step = _distance(b, c)
            if size < 6 or not .5 < step <= 2 * snap or min(_distance(a, b), _distance(c, d)) < 4 * step:
                continue
            direction, normal, _ = _line(a, b)
            other, _, _ = _line(c, d)
            if (sum(x * y for x, y in zip(direction, other)) < math.cos(math.radians(3))
                    or abs(direction[0] * (c[0] - b[0]) + direction[1] * (c[1] - b[1])) > .15 * step):
                continue
            # A real connector, even slightly displaced from the model, is not tracing noise.
            if (any(option["support"] >= .65 for option in _vector_candidates(b, c, segments, snap))
                    or _raster_candidates(b, c, raster, min(2., snap), None)):
                continue
            affected = {index, (index + 1) % size, (index + 2) % size}
            radius = min(3 * snap, step + snap)
            before, after = result[index - 1], result[(index + 4) % size]
            candidates = []
            for option in _vector_candidates(a, b, segments, radius):
                n, offset = option["normal"], option["offset"]
                aligned = [segment for segment in segments if all(
                    abs(n[0] * p[0] + n[1] * p[1] - offset) < .5 for p in segment)]
                # Check each run separately: a long upper fragment must not hide an unsupported lower run.
                if option["support"] < .9 or not any(
                        other["support"] >= .9 for other in _vector_candidates(c, d, aligned, radius)):
                    continue
                base = (n[0] * offset, n[1] * offset)
                end = (base[0] + n[1], base[1] - n[0])
                start_corner, end_corner = _meet(before, a, base, end), _meet(d, after, base, end)
                if start_corner is None or end_corner is None:
                    continue
                if (not _anchored_corner(start_corner, before, n, offset, segments, snap * 1.6)
                        or not _anchored_corner(end_corner, after, n, offset, segments, snap * 1.6)):
                    continue
                # Keep the source line continuous across the junction, not just on both distant runs.
                if not any(option["support"] >= .9 for option in
                           _vector_candidates(start_corner, end_corner, aligned, .5)):
                    continue
                middle = ((b[0] + c[0]) / 2, (b[1] + c[1]) / 2)
                shift = n[0] * middle[0] + n[1] * middle[1] - offset
                middle = (middle[0] - n[0] * shift, middle[1] - n[1] * shift)
                bridge = [(middle[0] + sign * 2 * snap * n[1], middle[1] - sign * 2 * snap * n[0])
                          for sign in (-1, 1)]
                if not any(option["support"] >= .9 for option in _vector_candidates(*bridge, aligned, .5)):
                    continue
                replacements = {index: start_corner, (index + 3) % size: end_corner}
                removed = {(index + 1) % size, (index + 2) % size}
                candidate = [replacements.get(i, point) for i, point in enumerate(result) if i not in removed]
                displacement = max(_distance(a, start_corner), _distance(d, end_corner),
                                   *(abs(n[0] * p[0] + n[1] * p[1] - offset) for p in (b, c)))
                if displacement > radius or not _within_continuity_limits(candidate, points, bounds):
                    continue
                candidates.append({"points": candidate, "normal": n, "offset": offset,
                                   "contrast": _side_contrast(start_corner, end_corner, n, offset, raster, winding)})
            chosen = candidates[0] if len(candidates) == 1 else None
            if len(candidates) == 2 and policy != "roof_deck":
                # Only resolve a close pair of faces when the image also establishes the desired side.
                first, second = candidates
                separation = abs(first["offset"] - second["offset"])
                if (2 < separation <= snap and all(item["contrast"] is not None for item in candidates)
                        and sum(x * y for x, y in zip(first["normal"], second["normal"])) > .9999):
                    sign = 1 if policy == "inner_parapet" else -1
                    ranked = sorted(candidates, key=lambda item: sign * item["contrast"], reverse=True)
                    # The selected face must agree with BOTH geometry and side contrast.
                    geometric = max(candidates, key=lambda item: sign * winding * item["offset"])
                    if (ranked[0] is geometric and sign * ranked[0]["contrast"] >= .08
                            and sign * (ranked[0]["contrast"] - ranked[1]["contrast"]) >= .12):
                        chosen = ranked[0]
            if chosen is None:
                uncertain |= affected
                continue
            result = chosen["points"]
            repaired_lines.append((chosen["normal"], chosen["offset"]))
            changed = True
            break
        if not changed:
            break
    fixed = {}
    for index, (a, b) in enumerate(zip(result, result[1:] + result[:1])):
        if index in uncertain or any(all(abs(n[0] * p[0] + n[1] * p[1] - offset) < .05 for p in (a, b))
                                    for n, offset in repaired_lines):
            fixed[index] = index in uncertain
    warnings = (["boundary_steps_straightened"] if repaired_lines else [])
    if uncertain:
        warnings.append("boundary_continuity_ambiguous")
    return result, fixed, warnings


def _contacts_roi(points, bounds):
    left, top, right, bottom = bounds
    return any(abs(a[axis] - value) < .5 and abs(b[axis] - value) < .5
               for a, b in zip(points, points[1:] + points[:1])
               for axis, value in ((0, left), (0, right), (1, top), (1, bottom)))


def _fit_ring(points, segments, raster, bounds, fixed_edges=None):
    left, top, right, bottom = bounds
    max_shift = _max_shift(bounds)
    dominant = _dominant_direction(points)
    lines, evidence, warnings = [], [], []
    for index, (a, b) in enumerate(zip(points, points[1:] + points[:1])):
        _, normal, offset = _line(a, b)
        if fixed_edges is not None and index in fixed_edges:
            # Preserve the continuity decision; ordinary edge fitting must not switch faces again.
            candidates = _vector_candidates(a, b, segments, .05)
            support = max((candidate["support"] for candidate in candidates), default=0.)
            source = "vector"
            if support < .55:
                support = _raster_support(a, b, normal, offset, raster)
                source = "raster" if support >= .55 else "unsupported"
            lines.append((normal, offset))
            evidence.append({"index": index, "support": round(support, 4), "source": source,
                             "ambiguous": fixed_edges[index]})
            continue
        candidates = _vector_candidates(a, b, segments, max_shift)
        if not candidates:
            candidates = _raster_candidates(a, b, raster, max_shift, dominant)
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
            support = _raster_support(a, b, normal, offset, raster)
            evidence.append({"index": index, "support": round(support, 4),
                             "source": "raster" if support >= .55 else "unsupported", "ambiguous": ambiguous})
            warnings.append("ambiguous_parallel_edges" if ambiguous else "unsupported_boundary_segments")
    original_lines = [_line(a, b)[1:] for a, b in zip(points, points[1:] + points[:1])]
    limited = set()
    while True:
        fitted = []
        for index, original in enumerate(points):
            (n1, c1), (n2, c2) = lines[index - 1], lines[index]
            det = n1[0] * n2[1] - n1[1] * n2[0]
            if abs(det) < .05:
                fitted.append(original)
            else:
                fitted.append(((c1 * n2[1] - n1[1] * c2) / det, (n1[0] * c2 - c1 * n2[0]) / det))
        # A small supporting-line shift at a shallow corner can produce a large
        # intersection displacement. Retain BOTH incident model lines locally,
        # rather than sacrificing unrelated supported fits around the whole roof.
        # Lock all offending pairs together; no vertex-order-dependent choices.
        unsafe = {index for index, (original, (x, y)) in enumerate(zip(points, fitted))
                  if _distance(original, (x, y)) > max_shift * 1.6
                  or not (left - EPS <= x <= right + EPS and top - EPS <= y <= bottom + EPS)}
        restore = {edge for index in unsafe for edge in ((index - 1) % len(points), index)
                   if edge not in limited and lines[edge] != original_lines[edge]}
        if not restore:
            break
        limited |= restore
        for index in restore:
            lines[index] = original_lines[index]
    if limited:
        warnings.append("local_fitting_limited")
        # Re-evaluate retained lines, not the rejected candidates. Mark them for
        # review so wider recovery cannot use them as trusted adjoining sides.
        for index in limited:
            a, b = points[index], points[(index + 1) % len(points)]
            n, c = original_lines[index]
            support = max((option["support"] for option in _vector_candidates(a, b, segments, .05)), default=0.)
            source = "vector"
            if support < .55:
                support = _raster_support(a, b, n, c, raster)
                source = "raster" if support >= .55 else "unsupported"
            evidence[index].update(support=round(support, 4), source=source, ambiguous=True)
            if support < .55:
                warnings.append("unsupported_boundary_segments")
    # The complete result still has to pass every original ring-wide safeguard.
    ratio = abs(_area(fitted)) / abs(_area(points))
    if (not _valid_ring(fitted) or _area(fitted) * _area(points) <= 0 or not .96 <= ratio <= 1.04
            or any(_distance(a, b) > max_shift * 1.6 for a, b in zip(points, fitted))
            or any(not left - EPS <= x <= right + EPS or not top - EPS <= y <= bottom + EPS for x, y in fitted)):
        fitted = points
        warnings.append("fitting_rejected")
        for edge, a, b in zip(evidence, points, points[1:] + points[:1]):
            _, n, c = _line(a, b)
            edge["support"] = round(_raster_support(a, b, n, c, raster), 4)
            edge["source"] = "raster" if edge["support"] >= .55 else "unsupported"
    if _contacts_roi(fitted, bounds):
        warnings.append("roi_boundary_contact")
    return fitted, evidence, sorted(set(warnings))


def _serialize(points, bounds):
    # Preserve fractional source coordinates: rounding to six decimal places can
    # put a valid point outside a fractional ROI by more than the client epsilon.
    # Rings were already checked against these bounds. Clamp machine roundoff
    # only (at most EPS), never a meaningful out-of-scope part of the polygon.
    left, top, right, bottom = bounds
    return [{"x": min(right, max(left, x)), "y": min(bottom, max(top, y))} for x, y in points]


def _continuous_vector_span(a, b, segments):
    """Require coverage from corner to corner, allowing only sub-pixel joins.

    A high aggregate coverage score alone can hide a gap in a long edge. Check
    every interval, including both ends, so separated strokes cannot bridge it.
    """
    direction, normal, offset = _line(a, b)
    length = _distance(a, b)
    intervals = []
    for start, end in segments:
        if any(abs(normal[0] * p[0] + normal[1] * p[1] - offset) >= .5 for p in (start, end)):
            continue
        projected = [(p[0] - a[0]) * direction[0] + (p[1] - a[1]) * direction[1] for p in (start, end)]
        lo, hi = max(0., min(projected)), min(length, max(projected))
        if hi > lo:
            intervals.append((lo, hi))
    reached = 0.
    for lo, hi in sorted(intervals):
        if lo > reached + 1.:
            return False
        reached = max(reached, hi)
    return reached >= length - 1. and _union_length(intervals) >= .98 * length


def _recover_unsupported_edges(fitted, original, segments, raster, bounds, fixed_edges):
    """Try a bounded, vector-only recovery after ordinary fitting.

    Supported or ambiguous edges never initiate this search. Both neighbouring
    sides must already be supported, and their finite PDF strokes must reach the
    new corners. Multiple plausible faces stay unresolved, for every policy.
    Decisions use one frozen ring: repairs cannot bootstrap one another or spend
    the area allowance repeatedly. The caller also checks component conflicts.
    """
    points, evidence, warnings = fitted
    if not segments or "fitting_rejected" in warnings or "component_conflict" in warnings:
        return fitted
    snap = _max_shift(bounds)
    radius = 2 * snap
    size = len(points)
    result, updated = list(points), [dict(edge) for edge in evidence]
    notes, recovered = set(warnings), set()
    dominant = _dominant_direction(points)
    for index, edge in enumerate(evidence):
        before_index, after_index = (index - 1) % size, (index + 1) % size
        if (index in fixed_edges or edge["source"] != "unsupported" or edge["ambiguous"]
                or any(evidence[i]["source"] != "vector" or evidence[i]["support"] < .7
                       or evidence[i]["ambiguous"] for i in (before_index, after_index))):
            continue
        before, a, b, after = points[before_index], points[index], points[after_index], points[(index + 2) % size]
        # Never bypass ordinary fitting's local evidence or an ambiguity/rejection.
        if (_distance(a, b) < 4 * radius or _vector_candidates(a, b, segments, snap)
                or _raster_candidates(a, b, raster, snap, dominant)):
            continue
        candidates = []
        for option in _vector_candidates(a, b, segments, radius):
            if option["support"] < .98:
                continue
            n, c = option["normal"], option["offset"]
            base = (n[0] * c, n[1] * c)
            along = (base[0] + n[1], base[1] - n[0])
            start, end = _meet(before, a, base, along), _meet(b, after, base, along)
            if (start is None or end is None or _distance(start, end) < .1
                    or max(_distance(a, start), _distance(b, end)) > radius
                    or not _continuous_vector_span(start, end, segments)
                    or not _anchored_corner(start, before, n, c, segments, .75)
                    or not _anchored_corner(end, after, n, c, segments, .75)):
                continue
            candidate = list(points)
            candidate[index], candidate[after_index] = start, end
            if _within_continuity_limits(candidate, original, bounds):
                candidates.append((start, end))
        if len(candidates) > 1:
            updated[index]["ambiguous"] = True
            notes.add("ambiguous_parallel_edges")
        elif len(candidates) == 1:
            result[index], result[after_index] = candidates[0]
            recovered.add(index)
    if recovered:
        # One shared area/topology/ROI budget covers ordinary fitting, continuity
        # repair and every recovery. Reject the batch rather than depend on order.
        if not _within_continuity_limits(result, original, bounds):
            return points, updated, sorted(notes | {"fitting_rejected"})
        affected = {i for index in recovered for i in ((index - 1) % size, index, (index + 1) % size)}
        for index in affected:
            a, b = result[index], result[(index + 1) % size]
            support = max((option["support"] for option in _vector_candidates(a, b, segments, .5)), default=0.)
            source = "vector"
            if support < .55:
                _, n, c = _line(a, b)
                support = _raster_support(a, b, n, c, raster)
                source = "raster" if support >= .55 else "unsupported"
            updated[index].update(support=round(support, 4), source=source)
        if all(edge["source"] != "unsupported" and edge["support"] >= .55 for edge in updated):
            notes.discard("unsupported_boundary_segments")
        notes.add("boundary_edges_recovered")
        if _contacts_roi(result, bounds):
            notes.add("roi_boundary_contact")
    return result, updated, sorted(notes)


def refine_outline_polygons(original: bytes, box: Sequence[float], crop: dict,
                            polygons: list[list[dict]], vector_segments: list[dict] | None = None, *,
                            source: SourceRaster | None = None, cleanup: str = "none",
                            boundary_policy: str = "inner_parapet") -> dict:
    """Map crop-normalized proposals to the source page and conservatively fit.

    No proposal is returned for an ROI that excludes any part of the proposed
    scope. Invalid rings, nested rings (holes) and touching components are errors.
    Evidence scores measure line support, not semantic or construction confidence.
    `source` reuses the pixels decoded by prepare_outline_crop for the same ROI.
    `cleanup="shapely"` first repairs invalid rings, clips ROI overshoot within the
    snapping radius and removes thinner spikes/slots (see outline_cleanup).
    """
    width, height = source.page_size if source is not None else _page_size(original)
    bounds = _bounds(box, width, height)
    if not isinstance(polygons, list) or len(polygons) > MAX_POLYGONS:
        raise RoiError("invalid_outline_geometry", 502)
    required = ("x", "y", "width", "height")
    if any(name not in crop for name in required):
        raise RoiError("invalid_outline_geometry", 502)
    x0, y0, cw, ch = [_number(crop[name]) for name in required]
    if cw <= 0 or ch <= 0 or x0 < 0 or y0 < 0 or x0 + cw > width or y0 + ch > height:
        raise RoiError("invalid_outline_geometry", 502)
    if cleanup not in {"none", "shapely"}:
        raise ValueError("invalid_outline_cleanup")
    if boundary_policy not in {"inner_parapet", "roof_deck", "outer_roof"}:
        raise ValueError("invalid_boundary_policy")
    rings, cleanup_warnings = [], set()
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
        if cleanup == "shapely":
            from .outline_cleanup import clean_ring

            parts, notes = clean_ring(ring, bounds=bounds, snap=_max_shift(bounds))
            cleanup_warnings |= notes
            if not parts:
                raise RoiError("invalid_outline_geometry", 502)
        else:
            parts = [ring]
        for part in parts:
            if not _valid_ring(part):
                raise RoiError("invalid_outline_geometry", 502)
            rings.append(_simplify(part))
    if len(rings) > MAX_POLYGONS or not _disjoint(rings):
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
    region = _raster_region(bounds, width, height)
    if source is None or not (source.origin[0] <= region[0] and source.origin[1] <= region[1]
                              and source.origin[0] + source.gray.width >= region[2]
                              and source.origin[1] + source.gray.height >= region[3]):
        source = SourceRaster(_rgb(original, region).convert("L"), region[:2], (width, height))
    raster = (source.gray.load(), source.origin, source.gray.width, source.gray.height)
    tolerance = 2 * _max_shift(bounds)
    straight = [_straighten_traced_sides(ring, tolerance / 2, bounds) for ring in rings]
    cleaned = [_collapse_corner_steps(ring, tolerance, bounds) for ring in straight]
    cleaned = [candidate if _within_continuity_limits(candidate, original, bounds) else original
               for candidate, original in zip(cleaned, rings)]
    if not _disjoint(cleaned):
        cleaned = rings
    continuous = [_repair_boundary_steps(ring, segments, raster, bounds, boundary_policy) for ring in cleaned]
    if not _disjoint([item[0] for item in continuous]):
        continuous = [(ring, {i: True for i in range(len(ring))},
                       ["boundary_continuity_ambiguous", "component_conflict"]) for ring in cleaned]
    fitted = [_fit_ring(ring, segments, raster, bounds, fixed) for ring, fixed, _ in continuous]
    for index, ((points, _, _), original, (_, _, warnings)) in enumerate(zip(fitted, rings, continuous)):
        normalized = len(cleaned[index]) != len(original) or "boundary_steps_straightened" in warnings
        if normalized and not _within_continuity_limits(points, original, bounds):
            # Normalization, fitting and repair share the original ring's allowance.
            fixed = {i: True for i in range(len(original))}
            continuous[index] = (original, fixed, ["boundary_continuity_ambiguous", "fitting_rejected"])
            fitted[index] = _fit_ring(original, segments, raster, bounds, fixed)
    if not _disjoint([item[0] for item in fitted]):
        # Do not merge separate roofs as a side effect of source snapping.
        fitted = [(ring, [{"index": index, "support": 0., "source": "unsupported", "ambiguous": True}
                          for index in range(len(ring))], ["fitting_rejected", "component_conflict"])
                  for ring, _, _ in continuous]
    recovered = [_recover_unsupported_edges(fit, original, segments, raster, bounds, fixed)
                 for fit, original, (_, fixed, _) in zip(fitted, rings, continuous)]
    if _disjoint([item[0] for item in recovered]):
        fitted = recovered
    else:
        # Preserve the safe ordinary fit if a wider move would join two roofs.
        for _, _, warnings in fitted:
            warnings[:] = sorted({*warnings, "fitting_rejected", "component_conflict"})
    for (_, _, warnings), (_, _, continuity_warnings) in zip(fitted, continuous):
        warnings[:] = sorted({*warnings, *continuity_warnings})
        if cleanup_warnings:
            warnings[:] = sorted({*warnings, *cleanup_warnings})
    proposals = [{"points": _serialize(points, bounds), "proposed_points": _serialize(original_points, bounds),
                  "edges": edges, "warnings": warnings}
                 for original_points, (points, edges, warnings) in zip(rings, fitted)]
    warnings = sorted({warning for item in proposals for warning in item["warnings"]})
    return {"status": "no_outline" if not proposals else "needs_review" if warnings else "complete",
            "proposals": proposals, "warnings": warnings}
