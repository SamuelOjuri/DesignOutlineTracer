"""Gemini Robotics-ER 1.5 segmentation backend.

This implements the :class:`Segmenter` protocol using the segmentation prompt
demonstrated in ``docs/gemini-robotics-er.ipynb``: the model returns a JSON
array of ``{"box_2d", "label", "mask"}`` items where ``mask`` is a base64 PNG
whose non-zero pixels mark the masked region inside ``box_2d``. Box-only
responses are semantic region proposals and should be refined against drawing
linework before becoming CAD geometry.

The actual Gemini call is supplied via an injectable ``model_call`` hook so the
contract is unit-testable without network or SDK dependencies.
"""

from __future__ import annotations

import base64
import io
import json
import textwrap
from collections.abc import Callable
from pathlib import Path
from typing import Any

import numpy as np
from PIL import Image

from app.models.raster import (
    SegmentationAudit,
    SegmentationCandidate,
    SegmentationHints,
)

SEGMENTATION_PROMPT = textwrap.dedent(
    """\
    Locate the proposed flat roof / tapered insulation scope area on this
    architectural roof plan. Exclude existing pitched roof, PV array, title
    block, legend and notes.

    Return only JSON. Prefer a box response in this format:
    [
      {
        "box_2d": [ymin, xmin, ymax, xmax],
        "label": "<label>",
        "mask": "data:image/png;base64,<base64 encoded PNG mask>"
      },
      ...
    ]

    box_2d coordinates are normalized to 0-1000 and must be integers.
    The mask is optional. If you cannot provide a box or mask, return a point
    anchor in this fallback format:
    [{"point": [y, x], "label": "<label>"}]

    Point coordinates are normalized to 0-1000 in [y, x] order.
    Return an empty JSON list [] if nothing is found.
    """
)


ModelCallable = Callable[[Image.Image, str], str]
RAW_RESPONSE_PREVIEW_CHARS = 1200
POINT_ANCHOR_BOX_FRACTION = 0.015


def _strip_json_fence(text: str) -> str:
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip().startswith("```"):
            remainder = "\n".join(lines[i + 1:])
            return remainder.split("```")[0]
    return text


def _decode_mask_data_uri(mask_field: str) -> Image.Image | None:
    if not isinstance(mask_field, str):
        return None
    if mask_field.startswith("data:"):
        try:
            mask_field = mask_field.split(",", 1)[1]
        except IndexError:
            return None
    try:
        raw = base64.b64decode(mask_field)
    except (ValueError, TypeError):
        return None
    try:
        return Image.open(io.BytesIO(raw))
    except Exception:  # pragma: no cover - defensive
        return None


def _polygon_from_mask_in_box(
    mask_image: Image.Image,
    bbox_px: list[float],
) -> list[list[float]]:
    """Approximate a polygon for the mask inside its pixel bounding box.

    The caller passes the box in pixel space; we resize the mask to that box,
    threshold it, and trace the outer contour with ``scikit-image``. If contour
    extraction fails, fall back to the box corners.
    """
    xmin, ymin, xmax, ymax = bbox_px
    width = max(1, int(round(xmax - xmin)))
    height = max(1, int(round(ymax - ymin)))
    fallback = [[xmin, ymin], [xmax, ymin], [xmax, ymax], [xmin, ymax]]

    try:
        mask_resized = mask_image.convert("L").resize((width, height), Image.NEAREST)
    except Exception:  # pragma: no cover - defensive
        return fallback
    array = np.array(mask_resized) > 0
    if not array.any():
        return fallback

    try:
        from skimage import measure
    except Exception:  # pragma: no cover - skimage is a hard dep
        return fallback

    contours = measure.find_contours(array.astype(float), 0.5)
    if not contours:
        return fallback
    longest = max(contours, key=len)
    polygon: list[list[float]] = []
    for row, col in longest:
        polygon.append([xmin + float(col), ymin + float(row)])
    if len(polygon) < 3:
        return fallback
    return polygon


class GeminiErSegmenter:
    """Gemini Robotics-ER 1.5 segmenter.

    Returns one :class:`SegmentationCandidate` per mask returned by the model,
    converted into pixel-space ``bbox_px`` and ``polygon_px`` so it slots into
    the existing raster pipeline.
    """

    provider_name = "gemini_er"

    def __init__(
        self,
        *,
        model_call: ModelCallable,
        model_name: str = "gemini-robotics-er-1.5-preview",
    ) -> None:
        self._model_call = model_call
        self._model_name = model_name
        self._live_calls = 0
        self._errors: list[str] = []
        self._raw_response_path: str | None = None
        self._raw_response_preview: str | None = None

    def segment(
        self,
        image: Image.Image,
        prompts: list[str],
        hints: SegmentationHints,
    ) -> list[SegmentationCandidate]:
        task_prompt = prompts[0] if prompts else "Segment the proposed flat roof area."
        prompt = _build_prompt(task_prompt)
        try:
            self._live_calls += 1
            raw = self._model_call(image, prompt)
        except Exception as exc:
            self._errors.append(str(exc))
            return []
        self._record_raw_response(raw, hints)
        return _adapt_response(raw, prompt=prompt, image_size=image.size)

    def audit(self) -> SegmentationAudit:
        return SegmentationAudit(
            provider=self.provider_name,
            model=self._model_name,
            prompt_count=1,
            live_calls=self._live_calls,
            available=not self._errors,
            errors=self._errors,
            raw_response_path=self._raw_response_path,
            raw_response_preview=self._raw_response_preview,
        )

    def _record_raw_response(self, raw: str, hints: SegmentationHints) -> None:
        self._raw_response_preview = raw[:RAW_RESPONSE_PREVIEW_CHARS]
        if hints.debug_dir_path is None:
            return
        debug_dir = Path(hints.debug_dir_path)
        debug_dir.mkdir(parents=True, exist_ok=True)
        path = debug_dir / "gemini_er_segmentation_raw_response.txt"
        path.write_text(raw, encoding="utf-8")
        self._raw_response_path = str(path)


def _build_prompt(task_prompt: str) -> str:
    return f"{SEGMENTATION_PROMPT.strip()}\n\nTask: {task_prompt.strip()}"


def _adapt_response(
    raw: str,
    *,
    prompt: str,
    image_size: tuple[int, int],
) -> list[SegmentationCandidate]:
    payload_text = _strip_json_fence(raw).strip()
    if not payload_text:
        return []
    try:
        data: Any = json.loads(payload_text)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []

    width_px, height_px = image_size
    candidates: list[SegmentationCandidate] = []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            continue
        bbox_2d = item.get("box_2d")
        if not _is_number_list(bbox_2d, expected_length=4):
            point_candidate = _point_anchor_candidate(
                item,
                index=index,
                prompt=prompt,
                image_size=image_size,
            )
            if point_candidate is not None:
                candidates.append(point_candidate)
            continue
        ymin, xmin, ymax, xmax = bbox_2d
        bbox_px = [
            (xmin / 1000.0) * width_px,
            (ymin / 1000.0) * height_px,
            (xmax / 1000.0) * width_px,
            (ymax / 1000.0) * height_px,
        ]
        # Guarantee a non-degenerate box.
        if bbox_px[2] <= bbox_px[0] or bbox_px[3] <= bbox_px[1]:
            continue

        polygon_px: list[list[float]]
        mask_image = _decode_mask_data_uri(str(item.get("mask", "")))
        if mask_image is not None:
            polygon_px = _polygon_from_mask_in_box(mask_image, bbox_px)
            source = "gemini_er_mask_region"
        else:
            polygon_px = [
                [bbox_px[0], bbox_px[1]],
                [bbox_px[2], bbox_px[1]],
                [bbox_px[2], bbox_px[3]],
                [bbox_px[0], bbox_px[3]],
            ]
            source = "gemini_er_box_region"

        area = max(0.0, (bbox_px[2] - bbox_px[0]) * (bbox_px[3] - bbox_px[1]))
        candidates.append(
            SegmentationCandidate(
                id=f"gemini_er_candidate_{index:02d}",
                source=source,
                provider="gemini_er",
                prompt=prompt,
                label=str(item.get("label", "proposed flat roof area")),
                bbox_px=bbox_px,
                polygon_px=polygon_px,
                mask_area_px=area,
                geometry_confidence=float(item.get("confidence", 0.6)),
                semantic_confidence=float(item.get("semantic_confidence", 0.65)),
            )
        )
    return candidates


def _is_number_list(value: Any, *, expected_length: int) -> bool:
    return (
        isinstance(value, list)
        and len(value) == expected_length
        and all(isinstance(v, (int, float)) for v in value)
    )


def _point_anchor_candidate(
    item: dict[str, Any],
    *,
    index: int,
    prompt: str,
    image_size: tuple[int, int],
) -> SegmentationCandidate | None:
    point = item.get("point")
    if not _is_number_list(point, expected_length=2):
        return None

    width_px, height_px = image_size
    point_norm = [int(point[0]), int(point[1])]
    y_norm, x_norm = point_norm
    point_px = [(x_norm / 1000.0) * width_px, (y_norm / 1000.0) * height_px]
    bbox_px = _point_anchor_bbox(point_px, image_size)
    polygon_px = [
        [bbox_px[0], bbox_px[1]],
        [bbox_px[2], bbox_px[1]],
        [bbox_px[2], bbox_px[3]],
        [bbox_px[0], bbox_px[3]],
    ]
    area = max(0.0, (bbox_px[2] - bbox_px[0]) * (bbox_px[3] - bbox_px[1]))
    return SegmentationCandidate(
        id=f"gemini_er_point_anchor_{index:02d}",
        type="point_anchor",
        source="gemini_er_point_anchor",
        provider="gemini_er",
        prompt=prompt,
        label=str(item.get("label", "proposed flat roof area")),
        point_norm=point_norm,
        point_px=point_px,
        bbox_px=bbox_px,
        polygon_px=polygon_px,
        mask_area_px=area,
        geometry_confidence=float(item.get("confidence", 0.35)),
        semantic_confidence=float(item.get("semantic_confidence", 0.72)),
        review_required=True,
    )


def _point_anchor_bbox(
    point_px: list[float],
    image_size: tuple[int, int],
) -> list[float]:
    width_px, height_px = image_size
    half_size = max(32.0, min(width_px, height_px) * POINT_ANCHOR_BOX_FRACTION)
    return [
        max(0.0, point_px[0] - half_size),
        max(0.0, point_px[1] - half_size),
        min(float(width_px), point_px[0] + half_size),
        min(float(height_px), point_px[1] + half_size),
    ]
