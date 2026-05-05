import re
from pathlib import Path

import fitz

from app.models.vector import (
    ClassifiedTextBlock,
    PageMetadata,
    RooflightRectangle,
    SheetRegion,
    TextBlock,
    VectorDocument,
    VectorExtractionSummary,
    VectorPrimitive,
    VectorPrimitiveRole,
)
from app.services.ai.provider import AiProvider

AXIS_TOLERANCE = 0.8
RECTANGLE_TOLERANCE = 1.0


def extract_vector_document(
    path: Path,
    document_id: str,
    ai_provider: AiProvider,
) -> VectorDocument:
    with fitz.open(path) as document:
        page_metadata: list[PageMetadata] = []
        text_blocks: list[TextBlock] = []
        vector_primitives: list[VectorPrimitive] = []
        rooflight_rectangles: list[RooflightRectangle] = []
        sheet_regions: list[SheetRegion] = []

        for page_index, page in enumerate(document):
            page_number = page_index + 1
            page_metadata.append(_extract_page_metadata(page, page_number))
            page_text_blocks = _extract_text_blocks(page, page_number, len(text_blocks))
            text_blocks.extend(page_text_blocks)
            vector_primitives.extend(
                _extract_vector_primitives(page, page_number, len(vector_primitives))
            )
            sheet_regions.extend(_detect_sheet_regions(page, page_number, page_text_blocks))
            rooflight_rectangles.extend(
                _detect_rooflight_rectangles(
                    page,
                    page_number,
                    len(rooflight_rectangles),
                    page_text_blocks,
                )
            )

    classified_blocks = ai_provider.classify_text_blocks(text_blocks)
    classifications_by_id = {block.id: block for block in classified_blocks}
    text_blocks = [_apply_classification(block, classifications_by_id) for block in text_blocks]
    vector_primitives = _apply_primitive_roles(
        vector_primitives=vector_primitives,
        sheet_regions=sheet_regions,
        text_blocks=text_blocks,
        rooflight_rectangles=rooflight_rectangles,
    )

    rwp_labels = _extract_rwp_labels(text_blocks)

    return VectorDocument(
        document_id=document_id,
        source_file=path.name,
        page_metadata=page_metadata,
        text_blocks=text_blocks,
        classified_text_blocks=classified_blocks,
        vector_primitives=vector_primitives,
        sheet_regions=sheet_regions,
        rooflight_rectangles=rooflight_rectangles,
        summary=VectorExtractionSummary(
            text_block_count=len(text_blocks),
            classified_text_block_count=len(classified_blocks),
            vector_primitive_count=len(vector_primitives),
            sheet_region_count=len(sheet_regions),
            rwp_label_count=len(rwp_labels),
            rwp_labels=rwp_labels,
            rooflight_rectangle_count=len(rooflight_rectangles),
        ),
    )


def _extract_page_metadata(page: fitz.Page, page_number: int) -> PageMetadata:
    return PageMetadata(
        page_number=page_number,
        page_width=round(page.rect.width, 3),
        page_height=round(page.rect.height, 3),
        rotation=page.rotation,
        media_box=_rect_to_list(page.mediabox),
        crop_box=_rect_to_list(page.cropbox),
    )


def _extract_text_blocks(page: fitz.Page, page_number: int, offset: int) -> list[TextBlock]:
    blocks: list[TextBlock] = []
    for block in page.get_text("dict").get("blocks", []):
        if block.get("type") != 0:
            continue
        lines: list[str] = []
        for line in block.get("lines", []):
            text = "".join(str(span.get("text", "")) for span in line.get("spans", [])).strip()
            if text:
                lines.append(text)
        joined_text = "\n".join(lines).strip()
        if not joined_text:
            continue
        blocks.append(
            TextBlock(
                id=f"txt_{offset + len(blocks) + 1:05d}",
                page_number=page_number,
                text=joined_text,
                bbox_pdf=_bbox_to_list(block["bbox"]),
            )
        )
    return blocks


def _extract_vector_primitives(
    page: fitz.Page,
    page_number: int,
    offset: int,
) -> list[VectorPrimitive]:
    primitives: list[VectorPrimitive] = []
    for drawing in page.get_drawings():
        stroke_width = float(drawing.get("width") or 0)
        stroke_colour = _colour_to_list(drawing.get("color"))
        fill_colour = _colour_to_list(drawing.get("fill"))
        dash = str(drawing.get("dashes")) if drawing.get("dashes") else None

        for item in drawing.get("items", []):
            primitive = _primitive_from_item(
                item=item,
                primitive_id=f"v_{offset + len(primitives) + 1:06d}",
                page_number=page_number,
                stroke_width=stroke_width,
                stroke_colour=stroke_colour,
                fill_colour=fill_colour,
                dash=dash,
            )
            if primitive is not None:
                primitives.append(primitive)
    return primitives


def _primitive_from_item(
    *,
    item: tuple[object, ...],
    primitive_id: str,
    page_number: int,
    stroke_width: float,
    stroke_colour: list[float] | None,
    fill_colour: list[float] | None,
    dash: str | None,
) -> VectorPrimitive | None:
    item_type = item[0]
    if item_type == "l":
        start = item[1]
        end = item[2]
        if not isinstance(start, fitz.Point) or not isinstance(end, fitz.Point):
            return None
        return VectorPrimitive(
            id=primitive_id,
            page_number=page_number,
            type="line",
            bbox_pdf=_points_bbox([start, end]),
            start_pdf=_point_to_list(start),
            end_pdf=_point_to_list(end),
            stroke_width=stroke_width,
            stroke_colour=stroke_colour,
            fill_colour=fill_colour,
            dash=dash,
        )
    if item_type == "re":
        rect = item[1]
        if not isinstance(rect, fitz.Rect):
            return None
        return VectorPrimitive(
            id=primitive_id,
            page_number=page_number,
            type="rect",
            bbox_pdf=_rect_to_list(rect),
            stroke_width=stroke_width,
            stroke_colour=stroke_colour,
            fill_colour=fill_colour,
            dash=dash,
        )
    if item_type in {"c", "qu"}:
        points = [value for value in item[1:] if isinstance(value, fitz.Point)]
        return VectorPrimitive(
            id=primitive_id,
            page_number=page_number,
            type="curve" if item_type == "c" else "quad",
            bbox_pdf=_points_bbox(points),
            stroke_width=stroke_width,
            stroke_colour=stroke_colour,
            fill_colour=fill_colour,
            dash=dash,
        )
    return None


def _detect_sheet_regions(
    page: fitz.Page,
    page_number: int,
    text_blocks: list[TextBlock],
) -> list[SheetRegion]:
    width = page.rect.width
    height = page.rect.height
    title_candidates = [
        block.bbox_pdf
        for block in text_blocks
        if block.bbox_pdf[0] >= width * 0.50 and block.bbox_pdf[1] >= height * 0.65
    ]
    if not title_candidates:
        title_candidates = [
            block.bbox_pdf
            for block in text_blocks
            if block.bbox_pdf[0] >= width * 0.75 or block.bbox_pdf[1] >= height * 0.88
        ]

    regions: list[SheetRegion] = []
    if title_candidates:
        title_bbox = _union_bboxes(title_candidates, padding=8, page_rect=page.rect)
        regions.append(
            SheetRegion(
                type="title_block",
                page_number=page_number,
                bbox_pdf=title_bbox,
                confidence=0.78,
            )
        )
        viewport_right = max(0.0, title_bbox[0] - 12)
        regions.append(
            SheetRegion(
                type="drawing_viewport",
                page_number=page_number,
                bbox_pdf=[0.0, 0.0, round(viewport_right, 3), round(height, 3)],
                confidence=0.72,
            )
        )
    else:
        regions.append(
            SheetRegion(
                type="drawing_viewport",
                page_number=page_number,
                bbox_pdf=[0.0, 0.0, round(width, 3), round(height, 3)],
                confidence=0.55,
            )
        )

    notes_candidates = [
        block.bbox_pdf
        for block in text_blocks
        if block.bbox_pdf[0] >= width * 0.70 and block.bbox_pdf[1] < height * 0.65
    ]
    if notes_candidates:
        regions.append(
            SheetRegion(
                type="notes",
                page_number=page_number,
                bbox_pdf=_union_bboxes(notes_candidates, padding=8, page_rect=page.rect),
                confidence=0.65,
            )
        )
    return regions


def _detect_rooflight_rectangles(
    page: fitz.Page,
    page_number: int,
    offset: int,
    text_blocks: list[TextBlock],
) -> list[RooflightRectangle]:
    page_text = (page.get_text("text") or "").lower()
    if not re.search(r"roof\s*lights?|rooflights?", page_text):
        return []

    horizontal: list[tuple[float, float, float]] = []
    vertical: list[tuple[float, float, float]] = []
    direct_rectangles: list[tuple[float, float, float, float]] = []
    viewport_right = page.rect.width * 0.78
    viewport_bottom = page.rect.height * 0.90

    for drawing in page.get_drawings():
        for item in drawing.get("items", []):
            if item[0] == "re" and isinstance(item[1], fitz.Rect):
                rect = item[1]
                if rect.x1 <= viewport_right and rect.y1 <= viewport_bottom:
                    width = rect.width
                    height = rect.height
                    if 25 <= width <= 220 and 25 <= height <= 180:
                        direct_rectangles.append(
                            (
                                round(rect.x0, 1),
                                round(rect.y0, 1),
                                round(rect.x1, 1),
                                round(rect.y1, 1),
                            )
                        )
                continue
            if item[0] != "l":
                continue
            start = item[1]
            end = item[2]
            if not isinstance(start, fitz.Point) or not isinstance(end, fitz.Point):
                continue
            if max(start.x, end.x) > viewport_right or max(start.y, end.y) > viewport_bottom:
                continue

            if abs(start.y - end.y) < AXIS_TOLERANCE and abs(start.x - end.x) > 8:
                x0, x1 = sorted((start.x, end.x))
                horizontal.append((round(start.y, 1), round(x0, 1), round(x1, 1)))
            elif abs(start.x - end.x) < AXIS_TOLERANCE and abs(start.y - end.y) > 8:
                y0, y1 = sorted((start.y, end.y))
                vertical.append((round(start.x, 1), round(y0, 1), round(y1, 1)))

    rectangles: list[tuple[float, float, float, float]] = [*direct_rectangles]
    for y0, x0, x1 in horizontal:
        for y1, other_x0, other_x1 in horizontal:
            if y1 <= y0 + 8:
                continue
            if abs(x0 - other_x0) > RECTANGLE_TOLERANCE:
                continue
            if abs(x1 - other_x1) > RECTANGLE_TOLERANCE:
                continue
            width = x1 - x0
            height = y1 - y0
            if not (25 <= width <= 220 and 25 <= height <= 180):
                continue
            has_left = any(
                abs(x - x0) <= RECTANGLE_TOLERANCE and top <= y0 + 1 and bottom >= y1 - 1
                for x, top, bottom in vertical
            )
            has_right = any(
                abs(x - x1) <= RECTANGLE_TOLERANCE and top <= y0 + 1 and bottom >= y1 - 1
                for x, top, bottom in vertical
            )
            if has_left and has_right:
                rectangles.append((x0, y0, x1, y1))

    deduped: list[tuple[float, float, float, float]] = []
    for rectangle in rectangles:
        if _is_near_pv_array_text(rectangle, text_blocks):
            continue
        if not _is_supported_rooflight_rectangle(rectangle, text_blocks):
            continue
        if not any(_same_rectangle(rectangle, existing) for existing in deduped):
            deduped.append(rectangle)

    return [
        RooflightRectangle(
            id=f"rooflight_rect_{offset + index + 1:03d}",
            page_number=page_number,
            bbox_pdf=[round(value, 3) for value in rectangle],
            source="axis_aligned_vector_linework",
            confidence=0.82
            if _near_text_tokens_bbox(
                rectangle,
                text_blocks,
                {"rooflight", "roof light"},
                tolerance=180,
            )
            else 0.68,
        )
        for index, rectangle in enumerate(deduped)
    ]


def _apply_classification(
    text_block: TextBlock,
    classifications_by_id: dict[str, ClassifiedTextBlock],
) -> TextBlock:
    classification = classifications_by_id.get(text_block.id)
    if classification is None:
        return text_block
    return text_block.model_copy(
        update={
            "text_class": classification.text_class,
            "semantic_confidence": classification.semantic_confidence,
        }
    )


def _apply_primitive_roles(
    *,
    vector_primitives: list[VectorPrimitive],
    sheet_regions: list[SheetRegion],
    text_blocks: list[TextBlock],
    rooflight_rectangles: list[RooflightRectangle],
) -> list[VectorPrimitive]:
    return [
        primitive.model_copy(
            update={
                "semantic_role": _classify_primitive_role(
                    primitive=primitive,
                    sheet_regions=sheet_regions,
                    text_blocks=text_blocks,
                    rooflight_rectangles=rooflight_rectangles,
                )
            }
        )
        for primitive in vector_primitives
    ]


def _classify_primitive_role(
    *,
    primitive: VectorPrimitive,
    sheet_regions: list[SheetRegion],
    text_blocks: list[TextBlock],
    rooflight_rectangles: list[RooflightRectangle],
) -> VectorPrimitiveRole:
    bbox = primitive.bbox_pdf
    length = _primitive_length(primitive)
    is_axis_aligned = bool(
        primitive.start_pdf
        and primitive.end_pdf
        and (
            abs(primitive.start_pdf[0] - primitive.end_pdf[0]) < AXIS_TOLERANCE
            or abs(primitive.start_pdf[1] - primitive.end_pdf[1]) < AXIS_TOLERANCE
        )
    )
    if any(
        region.type in {"title_block", "legend"}
        and _bbox_overlap_ratio(bbox, region.bbox_pdf) > 0.05
        for region in sheet_regions
    ):
        return "title_block"
    if any(
        region.type == "notes" and _bbox_overlap_ratio(bbox, region.bbox_pdf) > 0.05
        for region in sheet_regions
    ):
        return "notes"
    if any(
        _bbox_overlap_ratio(bbox, rooflight.bbox_pdf) > 0.35
        for rooflight in rooflight_rectangles
    ):
        return "rooflight"
    if length <= 260 and _near_text_class(
        primitive,
        text_blocks,
        {"pv_note"},
        tolerance=100,
    ):
        return "pv_array"
    if _near_text_class(primitive, text_blocks, {"rwp_label"}, tolerance=90) and (
        primitive.type in {"curve", "rect"} or length <= 140
    ):
        return "drainage_symbol"
    if length <= 160 and not is_axis_aligned and _near_text_class(
        primitive,
        text_blocks,
        {"fall_path_note", "drainage_note"},
        tolerance=120,
    ):
        return "fall_arrow"
    if primitive.type == "line" and length <= 220 and _near_text_class(
        primitive,
        text_blocks,
        {"roof_build_up_note", "tapered_scope_note", "flat_roof_note"},
        tolerance=60,
    ):
        return "leader_line"

    if primitive.type == "line" and is_axis_aligned and length >= 80:
        if primitive.stroke_width >= 0.2:
            return "roof_perimeter"
        if primitive.stroke_width <= 0.05:
            return "hatch"
        return "parapet_or_wall"
    if primitive.type == "line" and length < 80:
        return "hatch"
    return "unknown"


def _near_text_class(
    primitive: VectorPrimitive,
    text_blocks: list[TextBlock],
    text_classes: set[str],
    *,
    tolerance: float,
) -> bool:
    center_x, center_y = _bbox_center(primitive.bbox_pdf)
    for block in text_blocks:
        if block.text_class not in text_classes:
            continue
        block_x, block_y = _bbox_center(block.bbox_pdf)
        if ((center_x - block_x) ** 2 + (center_y - block_y) ** 2) ** 0.5 <= tolerance:
            return True
    return False


def _near_text_tokens_bbox(
    bbox: tuple[float, float, float, float],
    text_blocks: list[TextBlock],
    tokens: set[str],
    *,
    tolerance: float,
) -> bool:
    center_x, center_y = _bbox_center(list(bbox))
    for block in text_blocks:
        text = block.text.lower()
        if not any(token in text for token in tokens):
            continue
        block_x, block_y = _bbox_center(block.bbox_pdf)
        if ((center_x - block_x) ** 2 + (center_y - block_y) ** 2) ** 0.5 <= tolerance:
            return True
    return False


def _is_near_pv_array_text(
    bbox: tuple[float, float, float, float],
    text_blocks: list[TextBlock],
) -> bool:
    return _near_text_tokens_bbox(
        bbox,
        text_blocks,
        {"pv", "photovoltaic", "solar panel"},
        tolerance=180,
    ) or _overlaps_text_tokens_bbox(
        bbox,
        text_blocks,
        {"pv", "photovoltaic", "solar panel"},
        padding=150,
    )


def _is_supported_rooflight_rectangle(
    bbox: tuple[float, float, float, float],
    text_blocks: list[TextBlock],
) -> bool:
    return _near_text_tokens_bbox(
        bbox,
        text_blocks,
        {"rooflight", "roof light", "rooflights", "roof lights"},
        tolerance=220,
    )


def _overlaps_text_tokens_bbox(
    bbox: tuple[float, float, float, float],
    text_blocks: list[TextBlock],
    tokens: set[str],
    *,
    padding: float,
) -> bool:
    bbox_list = list(bbox)
    for block in text_blocks:
        text = block.text.lower()
        if not any(token in text for token in tokens):
            continue
        expanded = [
            block.bbox_pdf[0] - padding,
            block.bbox_pdf[1] - padding,
            block.bbox_pdf[2] + padding,
            block.bbox_pdf[3] + padding,
        ]
        if _bbox_overlap_ratio(bbox_list, expanded) > 0:
            return True
    return False


def _primitive_length(primitive: VectorPrimitive) -> float:
    if primitive.start_pdf is None or primitive.end_pdf is None:
        x0, y0, x1, y1 = primitive.bbox_pdf
        return float(max(x1 - x0, y1 - y0))
    return float(
        (
            (primitive.start_pdf[0] - primitive.end_pdf[0]) ** 2
            + (primitive.start_pdf[1] - primitive.end_pdf[1]) ** 2
        )
        ** 0.5
    )


def _bbox_center(bbox: list[float]) -> tuple[float, float]:
    return (bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2


def _bbox_overlap_ratio(left: list[float], right: list[float]) -> float:
    x0 = max(left[0], right[0])
    y0 = max(left[1], right[1])
    x1 = min(left[2], right[2])
    y1 = min(left[3], right[3])
    if x1 <= x0 or y1 <= y0:
        return 0.0
    overlap = (x1 - x0) * (y1 - y0)
    left_area = max((left[2] - left[0]) * (left[3] - left[1]), 1.0)
    return overlap / left_area


def _same_rectangle(
    left: tuple[float, float, float, float],
    right: tuple[float, float, float, float],
) -> bool:
    return all(abs(left[index] - right[index]) <= 2 for index in range(4))


def _extract_rwp_labels(text_blocks: list[TextBlock]) -> list[str]:
    labels: set[str] = set()
    for block in text_blocks:
        for match in re.finditer(r"\brwp\.?\s*(\d+)\b", block.text, flags=re.IGNORECASE):
            labels.add(f"rwp.{match.group(1)}")
    return sorted(labels, key=lambda label: int(label.split(".")[1]))


def _rect_to_list(rect: fitz.Rect) -> list[float]:
    return [round(rect.x0, 3), round(rect.y0, 3), round(rect.x1, 3), round(rect.y1, 3)]


def _bbox_to_list(bbox: tuple[float, float, float, float]) -> list[float]:
    return [round(value, 3) for value in bbox]


def _point_to_list(point: fitz.Point) -> list[float]:
    return [round(point.x, 3), round(point.y, 3)]


def _points_bbox(points: list[fitz.Point]) -> list[float]:
    if not points:
        return [0.0, 0.0, 0.0, 0.0]
    xs = [point.x for point in points]
    ys = [point.y for point in points]
    return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]


def _colour_to_list(colour: object) -> list[float] | None:
    if colour is None:
        return None
    if not isinstance(colour, tuple | list):
        return None
    return [round(float(channel), 4) for channel in colour]


def _union_bboxes(
    bboxes: list[list[float]],
    *,
    padding: float,
    page_rect: fitz.Rect,
) -> list[float]:
    x0 = max(0.0, min(bbox[0] for bbox in bboxes) - padding)
    y0 = max(0.0, min(bbox[1] for bbox in bboxes) - padding)
    x1 = min(page_rect.width, max(bbox[2] for bbox in bboxes) + padding)
    y1 = min(page_rect.height, max(bbox[3] for bbox in bboxes) + padding)
    return [round(x0, 3), round(y0, 3), round(x1, 3), round(y1, 3)]
