"""Small-object footprint validation and conservative, orientation-free fitting.

No bounding rectangle, convex hull, orthogonalization or topology repair replaces
an observed boundary. Unsupported model rings remain reviewable proposals.
"""
import math
from uuid import uuid4

from shapely import linestrings
from shapely.geometry import Polygon, box as rectangle
from shapely.strtree import STRtree

from .errors import RoiError
from .models import Annotation, PixelPoint
from .outline_geometry import _raster_candidates, _vector_candidates

ALGORITHM_VERSION = "penetration-footprints-v1"
MAX_CROPS = 8
TILE_SIDE = 2048
OVERLAP = 256


def points(ring):
    return [(point.x, point.y) for point in ring]


def valid_ring(ring):
    if (len(ring) < 3 or any(not math.isfinite(value) for point in ring for value in point)
            or len(set(ring)) != len(ring)
            or any(math.dist(a, b) <= 1e-7 for a, b in zip(ring, ring[1:] + ring[:1]))):
        return False
    polygon = Polygon(ring)
    return polygon.is_valid and polygon.area >= 1


def validate_scopes(request, width, height):
    for scope in request.scopes:
        for ring in [scope.outer, *scope.holes]:
            values = points(ring)
            if any(x > width or y > height for x, y in values) or not valid_ring(values):
                raise RoiError("invalid_scope_geometry")
        outer = Polygon(points(scope.outer))
        holes = [Polygon(points(ring)) for ring in scope.holes]
        if (any(not outer.covers(hole) for hole in holes)
                or not Polygon(points(scope.outer), [points(ring) for ring in scope.holes]).is_valid):
            raise RoiError("invalid_scope_geometry")
    if any(point.x > width or point.y > height for segment in request.vector_segments
           for point in (segment.start, segment.end)):
        raise RoiError("invalid_scope_geometry")


def plan_crops(request, width, height):
    crops = []
    for scope in request.scopes:
        shape = Polygon(points(scope.outer), [points(ring) for ring in scope.holes])
        left, top, right, bottom = shape.bounds

        def starts(low, high):
            count = max(1, math.ceil((high - low - OVERLAP) / (TILE_SIDE - OVERLAP)))
            return sorted(set(min(low + index * (TILE_SIDE - OVERLAP), max(low, high - TILE_SIDE))
                              for index in range(count)))

        for y in starts(top, bottom):
            for x in starts(left, right):
                end_x, end_y = min(x + TILE_SIDE, right), min(y + TILE_SIDE, bottom)
                if shape.intersection(rectangle(x, y, end_x, end_y)).area < 1:
                    continue
                if len(crops) == MAX_CROPS:
                    return crops, True
                crops.append((scope, [y / height * 1000, x / width * 1000,
                                      end_y / height * 1000, end_x / width * 1000]))
    return crops, False


def scope_in_crop(scope, crop):
    def point(value):
        return {"x": (value.x - crop["x"]) * 1000 / crop["width"],
                "y": (value.y - crop["y"]) * 1000 / crop["height"]}
    return {"roi_id": scope.roi_id, "outline_id": scope.outline_id,
            "outer": [point(value) for value in scope.outer],
            "holes": [[point(value) for value in ring] for ring in scope.holes]}


def closed_vector_rings(segments):
    """Only isolated degree-two loops qualify; hatch intersections cannot create a hull."""
    nodes, edges = {}, set()
    for a, b in segments:
        # PDF stroke endpoints are generally exact; tiny quantization joins numeric noise only.
        ka, kb = tuple(round(v, 3) for v in a), tuple(round(v, 3) for v in b)
        if ka == kb:
            continue
        edge = tuple(sorted((ka, kb)))
        if edge in edges:
            continue
        edges.add(edge)
        nodes.setdefault(ka, set()).add(kb)
        nodes.setdefault(kb, set()).add(ka)
    unseen = set(nodes)
    while unseen:
        first = next(iter(unseen))
        stack, component = [first], set()
        while stack:
            key = stack.pop()
            if key in component:
                continue
            component.add(key)
            stack.extend(nodes[key] - component)
        unseen -= component
        if not 3 <= len(component) <= 128 or any(len(nodes[key]) != 2 for key in component):
            continue
        ring, previous, current = [], None, first
        while current not in ring:
            ring.append(current)
            following = next(key for key in nodes[current] if key != previous)
            previous, current = current, following
        if current == first and len(ring) == len(component) and valid_ring(ring):
            yield ring


class VectorIndex:
    """Numeric stroke evidence indexed by bounds, retaining original stroke order."""

    def __init__(self, vector_segments):
        self.segments = [((segment.start.x, segment.start.y), (segment.end.x, segment.end.y))
                         for segment in vector_segments]
        self._tree = STRtree(linestrings(self.segments) if self.segments else [])

    def query(self, bounds):
        left, top, right, bottom = bounds
        # STRtree queries envelopes by default. Keep the explicit original test
        # as well, including touching/zero-length segments and numeric precision.
        return [self.segments[index] for index in sorted(self._tree.query(rectangle(*bounds)))
                if max(self.segments[index][0][0], self.segments[index][1][0]) >= left
                and min(self.segments[index][0][0], self.segments[index][1][0]) <= right
                and max(self.segments[index][0][1], self.segments[index][1][1]) >= top
                and min(self.segments[index][0][1], self.segments[index][1][1]) <= bottom]


def refine_ring(ring, vector_segments, source=None):
    shape = Polygon(ring)
    left, top, right, bottom = shape.bounds
    radius = max(.5, min(4., min(right - left, bottom - top) * .12))
    segments = (vector_segments.query((left - radius, top - radius, right + radius, bottom + radius))
                if isinstance(vector_segments, VectorIndex) else
                [(points([segment.start])[0], points([segment.end])[0]) for segment in vector_segments
                if max(segment.start.x, segment.end.x) >= left - radius
                and min(segment.start.x, segment.end.x) <= right + radius
                and max(segment.start.y, segment.end.y) >= top - radius
                and min(segment.start.y, segment.end.y) <= bottom + radius])
    candidates = []
    for loop in closed_vector_rings(segments):
        candidate = Polygon(loop)
        overlap = shape.intersection(candidate).area / shape.union(candidate).area
        if overlap >= .7 and shape.boundary.hausdorff_distance(candidate.boundary) <= radius * 1.5:
            candidates.append((overlap, loop))
    candidates.sort(key=lambda item: -item[0])
    if candidates:
        if len(candidates) == 1 or candidates[0][0] - candidates[1][0] >= .05:
            return candidates[0][1], "vector", []
        return ring, "model", ["penetration_boundary_ambiguous"]
    raster = ((source.gray.load(), source.origin, source.gray.width, source.gray.height)
              if source is not None else None)
    lines, sources = [], []
    for a, b in zip(ring, ring[1:] + ring[:1]):
        options = _vector_candidates(a, b, segments, radius)
        if not options and raster is not None:
            # dominant=None deliberately avoids imposing rectangular axes on an irregular object.
            options = _raster_candidates(a, b, raster, radius, None)
        options = sorted((option for option in options if option["support"] >= .75),
                         key=lambda option: (-option["score"], option["displacement"]))
        if not options:
            return ring, "model", ["penetration_boundary_unverified"]
        chosen = options[0]
        if any(abs(other["offset"] - chosen["offset"]) > .75
               and abs(other["score"] - chosen["score"]) < .04 for other in options[1:]):
            return ring, "model", ["penetration_boundary_ambiguous"]
        lines.append((chosen["normal"], chosen["offset"]))
        sources.append(chosen["source"])
    fitted = []
    for index, (normal, offset) in enumerate(lines):
        previous, previous_offset = lines[index - 1]
        determinant = previous[0] * normal[1] - previous[1] * normal[0]
        if abs(determinant) < 1e-6:
            fitted.append(ring[index])
        else:
            fitted.append(((previous_offset * normal[1] - previous[1] * offset) / determinant,
                           (previous[0] * offset - previous_offset * normal[0]) / determinant))
    if (not valid_ring(fitted) or not .8 <= Polygon(fitted).area / shape.area <= 1.2
            or any(math.dist(a, b) > radius * 1.5 for a, b in zip(fitted, ring))):
        return ring, "model", ["penetration_boundary_unverified"]
    return fitted, "vector" if all(value == "vector" for value in sources) else "raster", []


def annotation_from_proposal(proposal, page, annotation_id, crop=None, scope=None, vectors=(), source=None,
                             scope_polygon=None):
    width, height = page.image.width, page.image.height
    crop = crop or {"x": 0, "y": 0, "width": width, "height": height}
    top, left, bottom, right = proposal.box_2d
    box = ((crop["y"] + top / 1000 * crop["height"]) / height * 1000,
           (crop["x"] + left / 1000 * crop["width"]) / width * 1000,
           (crop["y"] + bottom / 1000 * crop["height"]) / height * 1000,
           (crop["x"] + right / 1000 * crop["width"]) / width * 1000)
    original = ([(crop["x"] + value.x / 1000 * crop["width"], crop["y"] + value.y / 1000 * crop["height"])
                 for value in proposal.footprint] if proposal.footprint else None)
    warnings, provenance, footprint = [], "legacy_box", None
    if original:
        if not valid_ring(original):
            raise RoiError("malformed_output", 502)
        footprint, provenance, warnings = refine_ring(original, vectors, source)
        if any(not 0 <= x <= width or not 0 <= y <= height for x, y in footprint):
            footprint, provenance = original, "model"
            warnings.append("penetration_boundary_unverified")
    else:
        warnings.append("penetration_boundary_requires_review")
    if proposal.subtype == "unknown":
        warnings.append("penetration_type_requires_review")
    if scope:
        shape = Polygon(footprint or [(box[1] * width / 1000, box[0] * height / 1000),
                                      (box[3] * width / 1000, box[0] * height / 1000),
                                      (box[3] * width / 1000, box[2] * height / 1000),
                                      (box[1] * width / 1000, box[2] * height / 1000)])
        usable = (scope_polygon if scope_polygon is not None
                  else Polygon(points(scope.outer), [points(hole) for hole in scope.holes]))
        overlap = shape.intersection(usable).area
        if overlap <= 1e-6:
            return None
        if overlap < shape.area - 1e-6:
            warnings.append("penetration_crosses_scope")
    return Annotation(id=annotation_id, page_id=page.context.page_id, kind="penetration", label=proposal.label,
                      subtype=proposal.subtype, roi_id=proposal.roi_id, box_2d=box, proposed_box_2d=box,
                      footprint=[PixelPoint(x=x, y=y) for x, y in footprint] if footprint else None,
                      proposed_footprint=[PixelPoint(x=x, y=y) for x, y in original] if original else None,
                      footprint_source=provenance, outline_id=scope.outline_id if scope else None,
                      warnings=list(dict.fromkeys(warnings)))


def annotations_from_proposals(proposals, page, crop, scope, vectors=(), source=None):
    """Fit a whole crop in one worker, reusing its scope and indexed evidence."""
    index = vectors if isinstance(vectors, VectorIndex) else VectorIndex(vectors)
    usable = Polygon(points(scope.outer), [points(hole) for hole in scope.holes]) if scope else None
    candidates = []
    for proposal in proposals:
        candidate = annotation_from_proposal(proposal, page, f"annotation_{uuid4().hex}", crop, scope,
                                             index, source, usable)
        if candidate is not None:
            candidates.append(candidate)
    return candidates


def duplicate(candidate, existing, width, height):
    def shape(annotation):
        if annotation.footprint:
            return Polygon(points(annotation.footprint))
        y1, x1, y2, x2 = annotation.box_2d
        return rectangle(x1 * width / 1000, y1 * height / 1000, x2 * width / 1000, y2 * height / 1000)
    current = shape(candidate)
    for previous in existing:
        if previous.roi_id != candidate.roi_id:
            continue
        other = shape(previous)
        intersection = current.intersection(other).area
        if intersection / current.union(other).area >= .65:
            return True
    return False
