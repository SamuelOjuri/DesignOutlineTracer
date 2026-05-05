import re
from collections.abc import Sequence

from shapely.geometry import Point, Polygon, box

from app.models.candidates import SemanticZone
from app.models.vector import VectorDocument

RooflightBBox = tuple[float, float, float, float]


def rooflights_expected(vector_document: VectorDocument) -> bool:
    return any(
        block.text_class in {"rooflight_label", "rooflight_spec"}
        or re.search(r"roof\s*lights?|rooflights?", block.text, flags=re.IGNORECASE)
        for block in vector_document.text_blocks
    )


def detect_scoped_rooflight_rectangles(
    *,
    vector_document: VectorDocument,
    target_polygon_pdf: Polygon,
    semantic_zones: Sequence[SemanticZone] = (),
) -> list[RooflightBBox]:
    vertical_edges = _scoped_dashed_vertical_edges(vector_document, target_polygon_pdf)
    pv_regions = [
        box(*zone.bbox_pdf).buffer(20)
        for zone in semantic_zones
        if zone.type == "pv_array" and zone.excluded
    ]
    rectangles: list[RooflightBBox] = []
    for index, left in enumerate(vertical_edges):
        for right in vertical_edges[index + 1 :]:
            width = right[0] - left[0]
            if not 45 <= width <= 70:
                continue
            y0 = max(left[1], right[1])
            y1 = min(left[2], right[2])
            height = y1 - y0
            if not 75 <= height <= 125:
                continue
            rectangle = (left[0], y0, right[0], y1)
            rectangle_box = box(*rectangle)
            if not target_polygon_pdf.buffer(4).contains(rectangle_box.centroid):
                continue
            if any(region.intersects(rectangle_box) for region in pv_regions):
                continue
            rectangles.append(
                (
                    round(rectangle[0], 3),
                    round(rectangle[1], 3),
                    round(rectangle[2], 3),
                    round(rectangle[3], 3),
                )
            )
            break
    return rectangles


def _scoped_dashed_vertical_edges(
    vector_document: VectorDocument,
    target_polygon_pdf: Polygon,
) -> list[tuple[float, float, float]]:
    segments: list[tuple[float, float, float]] = []
    excluded_roles = {"title_block", "notes", "dimension_line", "leader_line", "pv_array"}
    for primitive in vector_document.vector_primitives:
        if primitive.type != "line" or primitive.start_pdf is None or primitive.end_pdf is None:
            continue
        if primitive.semantic_role in excluded_roles:
            continue
        start_x, start_y = primitive.start_pdf
        end_x, end_y = primitive.end_pdf
        dx = abs(start_x - end_x)
        dy = abs(start_y - end_y)
        if dx > 2 or not 4 <= dy <= 20:
            continue
        mid = Point((start_x + end_x) / 2, (start_y + end_y) / 2)
        if not target_polygon_pdf.buffer(-2).contains(mid):
            continue
        segments.append(((start_x + end_x) / 2, min(start_y, end_y), max(start_y, end_y)))

    clusters: list[list[tuple[float, float, float]]] = []
    for segment in sorted(segments, key=lambda item: item[0]):
        for cluster in clusters:
            cluster_x = sum(item[0] for item in cluster) / len(cluster)
            if abs(cluster_x - segment[0]) <= 3:
                cluster.append(segment)
                break
        else:
            clusters.append([segment])

    edges: list[tuple[float, float, float]] = []
    for cluster in clusters:
        y_values = [value for _, y0, y1 in cluster for value in (y0, y1)]
        span = max(y_values) - min(y_values)
        coverage = sum(y1 - y0 for _, y0, y1 in cluster)
        if span >= 75 and coverage >= 45 and len(cluster) >= 6:
            x = sum(item[0] for item in cluster) / len(cluster)
            edges.append((round(x, 3), round(min(y_values), 3), round(max(y_values), 3)))
    return sorted(edges)