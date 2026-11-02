"""Shapely clean-up of model outlines before fitting (ROI_OUTLINE_CLEANUP, default "shapely").

Every change is reported as a warning, and nothing here decides scope: it only repairs
topology, absorbs ROI overshoot within the snapping radius, and removes spikes or slots
too thin to be roof geometry at that radius. See docs/roi-evaluation/outline-benchmark.md.
"""
from shapely import make_valid
from shapely.geometry import Polygon, box
from shapely.geometry.polygon import orient


def clean_ring(ring, *, bounds: tuple[float, float, float, float], snap: float) -> tuple[list[list[tuple]], set[str]]:
    """Return cleaned exterior rings (largest first) and the warnings describing each change.

    - Invalid rings (self-intersections, collinear back-tracks) are repaired; parts under 1%
      of the largest are discarded as repair slivers and interior holes are dropped, because
      the model contract has exterior rings only.
    - A ring exceeding the ROI by at most `snap` px is clipped to it. Larger overshoot is left
      unchanged so the caller still reports that the ROI excludes part of the scope.
    - Spikes and slots narrower than `snap` px are removed with square-cornered opening and
      closing; wider returns and steps are untouched.
    """
    warnings = set()
    polygon = Polygon(ring)
    # Keep the model's winding so later geometry and the client see the same orientation.
    winding = 1.0 if sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:] + ring[:1])) >= 0 else -1.0
    if not polygon.is_valid:
        polygon = make_valid(polygon)
        warnings.add("outline_repaired")
    parts = [part for part in getattr(polygon, "geoms", [polygon]) if part.geom_type == "Polygon" and part.area > 0]
    if not parts:
        return [], warnings
    largest = max(part.area for part in parts)
    region = box(*bounds)
    margin = region.buffer(snap, join_style="mitre")
    width = snap / 2
    result = []
    for part in sorted((part for part in parts if part.area >= largest * .01), key=lambda part: -part.area):
        part = Polygon(part.exterior)
        if not region.covers(part) and margin.covers(part):
            part = _largest(part.intersection(region))
            warnings.add("clipped_to_roi")
        if part is None:
            continue
        smoothed = _largest(part.buffer(-width, join_style="mitre").buffer(width, join_style="mitre")
                            .buffer(width, join_style="mitre").buffer(-width, join_style="mitre"))
        if smoothed is not None and smoothed.symmetric_difference(part).area > snap:
            part = smoothed
            warnings.add("thin_features_removed")
        result.append(list(orient(part, winding).exterior.coords)[:-1])
    return result, warnings


def _largest(geometry):
    parts = [part for part in getattr(geometry, "geoms", [geometry]) if part.geom_type == "Polygon" and part.area > 0]
    return Polygon(max(parts, key=lambda part: part.area).exterior) if parts else None
