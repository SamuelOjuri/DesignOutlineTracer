"""Bounded detail crops and geometric checks; never adjust an inlet anchor."""
import math

from .errors import RoiError
from .outlet_models import OutletInput, OutletScope
from .outline_geometry import _inside, _intersects, _valid_ring


MAX_CROPS = 8
TILE_SIDE = 2048
TILE_OVERLAP = 192
ALGORITHM_VERSION = "outlet-crops-v1"


def ring_points(ring):
    points = [(point.x, point.y) for point in ring]
    return points[:-1] if points[0] == points[-1] else points


def scope_location(anchor, scope: OutletScope) -> str:
    """Exterior boundary belongs to the roof; an opening boundary does not."""
    point = (anchor.x, anchor.y)
    if any(_inside(point, ring_points(ring)) for ring in scope.excluded_openings):
        return "opening"
    in_hole = False
    for polygon in scope.polygons:
        if _inside(point, ring_points(polygon.outer)):
            if any(_inside(point, ring_points(hole)) for hole in polygon.holes):
                in_hole = True
            else:
                return "inside"
    return "opening" if in_hole else "outside"


def validate_scopes(request: OutletInput, width: int, height: int):
    for scope in request.scopes:
        for ring in scope.excluded_openings:
            points = ring_points(ring)
            if any(x > width or y > height for x, y in points) or not _valid_ring(points):
                raise RoiError("invalid_scope_geometry")
        for polygon in scope.polygons:
            outer = ring_points(polygon.outer)
            for ring in [polygon.outer, *polygon.holes]:
                points = ring_points(ring)
                if any(x > width or y > height for x, y in points) or not _valid_ring(points):
                    raise RoiError("invalid_scope_geometry")
            for hole in polygon.holes:
                points = ring_points(hole)
                if not all(_inside(point, outer) for point in points):
                    raise RoiError("invalid_scope_geometry")
                if any(_intersects(a, b, c, d) for a, b in zip(outer, outer[1:] + outer[:1])
                       for c, d in zip(points, points[1:] + points[:1])):
                    raise RoiError("invalid_scope_geometry")


def _overlaps_polygon(rect, polygon):
    left, top, right, bottom = rect
    corners = [(left, top), (right, top), (right, bottom), (left, bottom)]
    outer = ring_points(polygon.outer)
    if any(left <= x <= right and top <= y <= bottom for x, y in outer):
        return True
    # Four corners in separate openings do not prove the entire tile is empty:
    # roof and an inlet may remain between them. Crop conservatively against the
    # exterior, and leave exact opening exclusion to the prompt/anchor check.
    if any(_inside(point, outer) for point in corners):
        return True
    return any(_intersects(a, b, c, d) for a, b in zip(outer, outer[1:] + outer[:1])
               for c, d in zip(corners, corners[1:] + corners[:1]))


def plan_crops(request: OutletInput, width: int, height: int):
    """Tile large components without blowing up image/call budgets; report omissions."""
    crops = []
    for scope in request.scopes:
        seen = set()
        for polygon in scope.polygons:
            points = ring_points(polygon.outer)
            left, right = min(p[0] for p in points), max(p[0] for p in points)
            top, bottom = min(p[1] for p in points), max(p[1] for p in points)
            if max(right - left, bottom - top) <= 2400:
                rectangles = [(left, top, right, bottom)]
            else:
                def starts(low, high):
                    count = max(1, math.ceil((high - low - TILE_OVERLAP) / (TILE_SIDE - TILE_OVERLAP)))
                    return [min(low + index * (TILE_SIDE - TILE_OVERLAP), max(low, high - TILE_SIDE))
                            for index in range(count)]
                rectangles = [(x, y, min(x + TILE_SIDE, right), min(y + TILE_SIDE, bottom))
                              for y in starts(top, bottom) for x in starts(left, right)]
            for rect in rectangles:
                if rect in seen or not _overlaps_polygon(rect, polygon):
                    continue
                seen.add(rect)
                if len(crops) >= MAX_CROPS:
                    return crops, True
                x1, y1, x2, y2 = rect
                crops.append((scope, [y1 / height * 1000, x1 / width * 1000,
                                      y2 / height * 1000, x2 / width * 1000]))
    return crops, False


def scope_in_crop(scope: OutletScope, crop: dict):
    # Vertices beyond the tile are intentional: the model sees the continuation
    # of the same scope. Only OUTPUT coordinates must be within the first image.
    def point(value):
        return {"x": (value.x - crop["x"]) / crop["width"] * 1000,
                "y": (value.y - crop["y"]) / crop["height"] * 1000}
    return {"polygons": [{"outer": [point(p) for p in polygon.outer],
                          "holes": [[point(p) for p in hole] for hole in polygon.holes]} for polygon in scope.polygons],
            "excluded_openings": [[point(p) for p in ring] for ring in scope.excluded_openings]}


def source_anchor(anchor, crop):
    return {"x": crop["x"] + anchor.x / 1000 * crop["width"],
            "y": crop["y"] + anchor.y / 1000 * crop["height"]}


def page_box(box, crop, width, height):
    top, left, bottom, right = box
    return ((crop["y"] + top / 1000 * crop["height"]) / height * 1000,
            (crop["x"] + left / 1000 * crop["width"]) / width * 1000,
            (crop["y"] + bottom / 1000 * crop["height"]) / height * 1000,
            (crop["x"] + right / 1000 * crop["width"]) / width * 1000)


def duplicate_anchor(candidate, existing, width, height):
    for previous in existing:
        if previous.roi_id != candidate.roi_id or previous.outline_id != candidate.outline_id:
            continue
        top, left, bottom, right = candidate.box_2d
        min_side = min((bottom - top) * height / 1000, (right - left) * width / 1000)
        tolerance = max(.5, min(4, min_side * .25))
        if math.hypot(previous.anchor.x - candidate.anchor.x, previous.anchor.y - candidate.anchor.y) <= tolerance:
            return True
    return False
