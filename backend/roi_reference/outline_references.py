"""Draft reference outlines: approximate scope -> edges on the innermost drawn face.

A reference is only a draft until a domain reviewer approves it. This module makes
each draft auditable: every edge records which drawn line it uses and why.
"""
import math
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient


def mask_polygon(path: Path, hsv_low: tuple[int, int, int], hsv_high: tuple[int, int, int], scale: float,
                 close: int = 9) -> list[tuple[float, float]]:
    """Largest filled region of one colour in a painted mask, scaled to page pixels."""
    image = cv2.imdecode(np.frombuffer(Path(path).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("unreadable_mask")
    mask = cv2.inRange(cv2.cvtColor(image, cv2.COLOR_BGR2HSV), hsv_low, hsv_high)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (close, close)))
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise ValueError("empty_mask")
    contour = max(contours, key=cv2.contourArea)[:, 0, :].astype(float) * scale
    return [(float(x), float(y)) for x, y in contour]


def clean_polygon(points, min_feature: float) -> Polygon:
    """Remove painted spikes and notches narrower than min_feature, keeping square corners."""
    width = min_feature / 2
    polygon = Polygon(points).buffer(0)
    polygon = polygon.buffer(-width, join_style="mitre").buffer(width, join_style="mitre")
    polygon = polygon.buffer(width, join_style="mitre").buffer(-width, join_style="mitre")
    if polygon.geom_type == "MultiPolygon":
        polygon = max(polygon.geoms, key=lambda part: part.area)
    return orient(polygon.simplify(2), 1.0)


def _orientation(a, b, tolerance=math.tan(math.radians(10))) -> str:
    dx, dy = abs(b[0] - a[0]), abs(b[1] - a[1])
    return "H" if dy <= tolerance * dx else "V" if dx <= tolerance * dy else "D"


def _coverage(axis: int, level: float, low: float, high: float, segments, offset: float):
    """Fraction of [low, high] covered by each drawn line within `offset` px of level.

    Fragments within 0.5 px of each other count as one drawn line at their mean position.
    """
    fragments = []
    for first, second in segments:
        if abs(first[axis] - second[axis]) > .6 or abs(first[axis] - level) > offset:
            continue
        start, stop = sorted((first[1 - axis], second[1 - axis]))
        if min(stop, high) > max(start, low):
            fragments.append(((first[axis] + second[axis]) / 2, max(start, low), min(stop, high)))
    groups = []
    for fragment in sorted(fragments):
        if groups and fragment[0] - groups[-1][-1][0] <= .5:
            groups[-1].append(fragment)
        else:
            groups.append([fragment])
    result = {}
    for group in groups:
        total, end = 0., -math.inf
        for _, start, stop in sorted(group, key=lambda item: item[1]):
            if stop > max(start, end):
                total += stop - max(start, end)
            end = max(end, stop)
        result[sum(item[0] for item in group) / len(group)] = total / max(high - low, 1e-9)
    return result


def _intersect(first, second):
    (p, r), (q, s) = first, second
    det = r[0] * s[1] - r[1] * s[0]
    if abs(det) < 1e-9:
        return None
    t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / det
    return p[0] + t * r[0], p[1] + t * r[1]


def _raster_edge(gray: np.ndarray, axis: int, level: float, low: float, high: float, search: float) -> float | None:
    """Strongest light/dark transition across an edge, for boundaries drawn as fills, not strokes."""
    trim = (high - low) * .1
    start, stop = int(low + trim), int(high - trim)
    first, last = int(level - search), int(level + search) + 1
    if stop <= start or first < 1 or last >= gray.shape[1 - axis] - 1:
        return None
    band = gray[first:last, start:stop] if axis == 1 else gray[start:stop, first:last].T
    profile = band.astype(float).mean(axis=1)
    gradient = np.abs(np.diff(profile))
    if gradient.max() < 20:
        return None
    return first + float(np.argmax(gradient)) + .5


def _unify_steps(edges, report, max_step: float, min_coverage: float):
    """Merge parallel edges joined by short connectors when one drawn line runs along both.

    Such steps come from painted or traced noise (for example at outlets); a step with
    no shared supporting line is real geometry and is kept.
    """
    changed = True
    while changed:
        changed = False
        count = len(edges)
        for index in range(count):
            for span in (2, 3):
                if count - span < 3:
                    continue
                first, last = report[index], report[(index + span) % count]
                between = [(index + offset) % count for offset in range(1, span)]
                if (first["kind"] == "D" or first["kind"] != last["kind"]
                        or any(math.dist(edges[i]["a"], edges[i]["b"]) > max_step for i in between)):
                    continue
                common = ({line for line, value in first.get("candidates", []) if value >= min_coverage}
                          & {line for line, value in last.get("candidates", []) if value >= min_coverage})
                if not common:
                    continue
                chosen = max(common, key=lambda line: (line - first["approximate"]) * first["sign"])
                merged_edge = {"kind": first["kind"], "a": edges[index]["a"], "b": edges[(index + span) % count]["b"]}
                merged_report = {**first, "chosen": round(chosen, 2), "source": "vector_merged_step",
                                 "merged_edges": [first["index"], *[report[i]["index"] for i in between], last["index"]]}
                removed = {(index + offset) % count for offset in range(1, span + 1)}
                edges = [merged_edge if i == index else edge for i, edge in enumerate(edges) if i not in removed]
                report = [merged_report if i == index else item for i, item in enumerate(report) if i not in removed]
                changed = True
                break
            if changed:
                break
    return edges, report


def snap_reference(points, segments, *, gray: np.ndarray | None = None, search: float = 16, overpaint: float = 3,
                   min_coverage: float = .5, min_feature: float = 12, overrides: dict[int, float] | None = None) -> dict:
    """Place each axis-aligned edge on the drawn line nearest the interior.

    Candidates are parallel lines within `search` px covering at least `min_coverage`
    of the edge. Lines more than `overpaint` px inside the approximate edge are
    treated as interior detail (dimensions, falls), not the boundary. Edges without
    a stroked line use the strongest raster transition (fill boundaries) when `gray`
    is supplied, otherwise they keep their approximate position. `overrides` maps an
    edge's reported index to a reviewer-chosen coordinate.
    """
    polygon = clean_polygon(points, min_feature)
    ring = list(polygon.exterior.coords)[:-1]
    segments = [((s["start"]["x"], s["start"]["y"]), (s["end"]["x"], s["end"]["y"])) for s in segments]
    edges = []
    for a, b in zip(ring, ring[1:] + ring[:1]):
        kind = _orientation(a, b)
        if edges and edges[-1]["kind"] == kind != "D":
            edges[-1]["b"] = b
        else:
            edges.append({"kind": kind, "a": a, "b": b})
    if len(edges) > 1 and edges[0]["kind"] == edges[-1]["kind"] != "D":
        edges[0]["a"] = edges.pop()["a"]
    report = []
    for index, edge in enumerate(edges):
        a, b, kind = edge["a"], edge["b"], edge["kind"]
        if kind == "D":
            report.append({"index": index, "kind": kind, "source": "approximate", "approximate": [a, b]})
            continue
        axis = 1 if kind == "H" else 0
        level = (a[axis] + b[axis]) / 2
        low, high = sorted((a[1 - axis], b[1 - axis]))
        # Counter-clockwise ring: the interior is left of travel, i.e. +dx (horizontal) or -dy (vertical).
        inward = (b[0] - a[0]) if axis == 1 else -(b[1] - a[1])
        sign = 1 if inward > 0 else -1
        covered = _coverage(axis, level, low, high, segments, search)
        candidates = sorted((round(line, 2), round(value, 3)) for line, value in covered.items() if value >= min_coverage)
        eligible = [line for line, _ in candidates if (line - level) * sign <= overpaint]
        if eligible:
            chosen, source = max(eligible, key=lambda line: (line - level) * sign), "vector"
        else:
            raster = _raster_edge(gray, axis, level, low, high, search) if gray is not None else None
            chosen, source = (raster, "raster") if raster is not None else (level, "approximate")
        report.append({"index": index, "kind": kind, "approximate": round(level, 2), "chosen": round(chosen, 2),
                       "source": source, "sign": sign, "candidates": candidates})
    edges, report = _unify_steps(edges, report, max_step=2.5 * min_feature, min_coverage=min_coverage)
    for position, item in enumerate(report):
        if overrides and item["index"] in overrides:
            item["chosen"], item["source"] = overrides[item["index"]], "override"
        item["position"] = position
    lines = []
    for edge, item in zip(edges, report):
        if item["kind"] == "D":
            lines.append((edge["a"], (edge["b"][0] - edge["a"][0], edge["b"][1] - edge["a"][1])))
        else:
            lines.append(((0., item["chosen"]), (1., 0.)) if item["kind"] == "H" else ((item["chosen"], 0.), (0., 1.)))
    vertices = []
    for index in range(len(lines)):
        corner = _intersect(lines[index - 1], lines[index])
        if corner is None:
            raise ValueError(f"parallel_adjacent_edges:{index}")
        vertices.append((round(corner[0], 2), round(corner[1], 2)))
    result = Polygon(vertices)
    if not result.is_valid or result.area <= 0:
        raise ValueError("invalid_reference_polygon")
    return {"points": vertices, "edges": report}


def render_review(page: Image.Image, rings, path: Path, *, approximate=None, tile: int = 160, zoom: int = 3) -> None:
    """Overview plus one zoomed tile per vertex, for human review of a draft reference."""
    points = [point for ring in rings for point in ring]
    xs, ys = [p[0] for p in points], [p[1] for p in points]
    margin = 80
    box = (max(0, int(min(xs)) - margin), max(0, int(min(ys)) - margin),
           min(page.width, int(max(xs)) + margin), min(page.height, int(max(ys)) + margin))
    overview = page.crop(box).convert("RGB")
    draw = ImageDraw.Draw(overview)
    shift = lambda ring: [(x - box[0], y - box[1]) for x, y in ring]
    for ring in approximate or []:
        draw.line(shift(ring) + shift(ring)[:1], fill=(0, 150, 255), width=2)
    for ring in rings:
        draw.line(shift(ring) + shift(ring)[:1], fill=(230, 0, 0), width=3)
    overview.thumbnail((1400, 1400))
    tiles = []
    for ring in rings:
        for x, y in ring:
            crop = page.crop((int(x) - tile // 2, int(y) - tile // 2, int(x) + tile // 2, int(y) + tile // 2)).convert("RGB")
            crop = crop.resize((tile * zoom, tile * zoom), Image.Resampling.NEAREST)
            tile_draw = ImageDraw.Draw(crop)
            local = [((px - x + tile // 2) * zoom, (py - y + tile // 2) * zoom) for px, py in ring]
            tile_draw.line(local + local[:1], fill=(230, 0, 0), width=2)
            tiles.append(crop)
    columns = 4
    rows = math.ceil(len(tiles) / columns)
    size = tile * zoom // 2
    sheet = Image.new("RGB", (max(overview.width, columns * size), overview.height + rows * size), "white")
    sheet.paste(overview, (0, 0))
    for index, crop in enumerate(tiles):
        crop.thumbnail((size, size))
        sheet.paste(crop, ((index % columns) * size, overview.height + (index // columns) * size))
    sheet.save(path)
