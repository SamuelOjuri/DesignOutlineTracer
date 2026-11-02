"""Experiment (reference tooling only): choose each edge's line by which side is open roof.

For the inner-parapet convention the wanted face has open roof surface on its inner side
and wall faces or hatching on its outer side. Production snapping scores lines by length of
support only, so it can pick an equally long wall line or keep the model's edge between two
parallel faces. This variant re-selects among the same vector candidates using an OpenCV ink
mask (small components such as text removed) and keeps production's result unless a
candidate is clearly better and the ring passes production's own acceptance checks.
"""
import math

import cv2
import numpy as np


def ink_mask(gray: np.ndarray, *, threshold: int = 190, min_extent: int = 25) -> np.ndarray:
    """Drawn linework as a boolean mask, without glyph-sized components (text, ticks, symbols)."""
    ink = (gray < threshold).astype(np.uint8)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    keep = (stats[:, cv2.CC_STAT_WIDTH] >= min_extent) | (stats[:, cv2.CC_STAT_HEIGHT] >= min_extent)
    keep[0] = False
    return keep[labels]


def side_ink(mask: np.ndarray, origin, a, b, normal, offset, inward, *, near=1.5, far=5.5, step=2.):
    """Ink fractions in thin strips inside and outside a candidate line over the edge span a-b."""
    project = lambda p: (p[0] - normal[0] * (normal[0] * p[0] + normal[1] * p[1] - offset),
                         p[1] - normal[1] * (normal[0] * p[0] + normal[1] * p[1] - offset))
    start, end = project(a), project(b)
    length = math.dist(start, end)
    count = max(4, int(length / step))
    sign = 1 if normal[0] * inward[0] + normal[1] * inward[1] > 0 else -1
    depths = np.arange(near, far + 1e-9, 1.)
    inside = outside = total = 0
    height, width = mask.shape
    for index in range(count):
        t = (index + .5) / count
        if not .1 <= t <= .9:  # corners belong to the neighbouring edges
            continue
        x, y = start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t
        for depth in depths:
            for side, target in ((sign, "in"), (-sign, "out")):
                px = int(round(x + normal[0] * depth * side)) - origin[0]
                py = int(round(y + normal[1] * depth * side)) - origin[1]
                value = bool(mask[py, px]) if 0 <= px < width and 0 <= py < height else False
                if target == "in":
                    inside += value
                else:
                    outside += value
        total += len(depths)
    return (inside / total, outside / total) if total else (0., 0.)


def side_aware_refine(png: bytes, box, crop: dict, polygons, vectors, *, cleanup: str = "shapely",
                      margin: float = .2) -> dict:
    from backend.app import outline_geometry as g

    result = g.refine_outline_polygons(png, box, crop, polygons, vectors, cleanup=cleanup)
    if not result["proposals"]:
        return result
    width, height = g._page_size(png)
    bounds = g._bounds(box, width, height)
    max_shift = g._max_shift(bounds)
    region = g._raster_region(bounds, width, height)
    mask = ink_mask(np.asarray(g._rgb(png, region).convert("L")))
    origin = region[:2]
    segments = [((s["start"]["x"], s["start"]["y"]), (s["end"]["x"], s["end"]["y"])) for s in vectors]
    left, top, right, bottom = bounds
    for proposal in result["proposals"]:
        points = [(point["x"], point["y"]) for point in proposal["points"]]
        area = g._area(points)
        lines, changed = [], False
        for a, b in zip(points, points[1:] + points[:1]):
            _, normal, offset = g._line(a, b)
            left_normal = (-(b[1] - a[1]), b[0] - a[0])
            inward = left_normal if area > 0 else (-left_normal[0], -left_normal[1])
            options = [(normal, offset)] + [(c["normal"], c["offset"]) for c in g._vector_candidates(a, b, segments, max_shift)]
            scored = []
            for option_normal, option_offset in options:
                inside, outside = side_ink(mask, origin, a, b, option_normal, option_offset, inward)
                scored.append((outside - inside, option_normal, option_offset))
            best = max(scored, key=lambda item: item[0])
            if best[0] >= scored[0][0] + margin:
                lines.append((best[1], best[2]))
                changed = True
            else:
                lines.append((normal, offset))
        if not changed:
            continue
        fitted = []
        for index, original in enumerate(points):
            (n1, c1), (n2, c2) = lines[index - 1], lines[index]
            det = n1[0] * n2[1] - n1[1] * n2[0]
            fitted.append(original if abs(det) < .05 else
                          ((c1 * n2[1] - n1[1] * c2) / det, (n1[0] * c2 - c1 * n2[0]) / det))
        ratio = abs(g._area(fitted)) / abs(area)
        if (g._valid_ring(fitted) and g._area(fitted) * area > 0 and .96 <= ratio <= 1.04
                and all(math.dist(p, q) <= max_shift * 1.6 for p, q in zip(points, fitted))
                and all(left - g.EPS <= x <= right + g.EPS and top - g.EPS <= y <= bottom + g.EPS for x, y in fitted)):
            proposal["points"] = [{"x": x, "y": y} for x, y in fitted]
            proposal["warnings"] = sorted({*proposal["warnings"], "side_aware_reselection"})
    return result
