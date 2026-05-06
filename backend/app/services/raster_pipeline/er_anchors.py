"""Vision-language semantic anchor extraction for the raster-first pipeline.

This module wraps the Gemini Robotics-ER 1.5 "pointing" capability demonstrated
in ``docs/gemini-robotics-er.ipynb`` into a small provider abstraction. The
model returns points (and optionally boxes) in normalized ``[y, x]`` 0-1000
coordinates; this module converts them into image pixel space so the downstream
candidate generator and CAD engine can consume them.

The Gemini-backed provider performs anchor classes in parallel using
``concurrent.futures`` exactly as the notebook recommends, and accepts an
injectable model-call hook so the contract can be unit-tested without making
network calls.
"""

from __future__ import annotations

import concurrent.futures
import json
import textwrap
from collections.abc import Callable
from typing import Any, Protocol

from PIL import Image

from app.models.anchors import (
    AnchorAudit,
    AnchorClass,
    AnchorExtractionResult,
    AnchorHints,
    SemanticAnchor,
)

# Anchor classes the system extracts and the natural-language queries used by
# the Robotics-ER pointing prompt. Wording mirrors the pointing-prompt patterns
# in the cookbook notebook.
ANCHOR_QUERIES: dict[AnchorClass, str] = {
    "rwp": (
        "rainwater downpipe outlet (labelled rwp.1, rwp.2, etc.) on the proposed "
        "flat roof"
    ),
    "rooflight": (
        "proprietary rooflight on the proposed flat roof, drawn as a hatched "
        "rectangle with an X across it"
    ),
    "fall_arrow": (
        "fall direction arrow indicating drainage flow on the flat roof "
        "(small arrow next to a 1:40 or 1:80 gradient note)"
    ),
    "pv_array": "PV solar panel array symbol on the roof",
    "hopper": "rainwater hopper at the head of a downpipe",
    "sump": "flat 70mm sump area on the tapered roof scheme",
}

POINT_PROMPT_TEMPLATE = textwrap.dedent(
    """\
    Point to every {object_query}. The label returned should be a short
    identifying name.

    The answer should follow the JSON format:
    [{{"point": [y, x], "label": <label>}}, ...]

    The points are in [y, x] format normalized to 0-1000.
    Return an empty JSON list [] if none are visible.
    """
)


class AnchorExtractor(Protocol):
    """Strategy contract for any semantic anchor extractor."""

    @property
    def provider_name(self) -> str: ...

    def extract(
        self,
        image: Image.Image,
        anchor_classes: list[AnchorClass],
        hints: AnchorHints,
    ) -> AnchorExtractionResult: ...


def _norm_point_to_px(
    point_norm: list[int],
    image_width_px: int,
    image_height_px: int,
) -> list[float]:
    """Convert a Robotics-ER normalized ``[y, x]`` point to ``[x_px, y_px]``."""
    y_norm, x_norm = point_norm[0], point_norm[1]
    x_px = (x_norm / 1000.0) * image_width_px
    y_px = (y_norm / 1000.0) * image_height_px
    return [x_px, y_px]


def _norm_bbox_to_px(
    bbox_norm: list[int],
    image_width_px: int,
    image_height_px: int,
) -> list[float]:
    """Convert ``[ymin, xmin, ymax, xmax]`` (0-1000) to pixel ``[xmin, ymin, xmax, ymax]``."""
    ymin, xmin, ymax, xmax = bbox_norm
    return [
        (xmin / 1000.0) * image_width_px,
        (ymin / 1000.0) * image_height_px,
        (xmax / 1000.0) * image_width_px,
        (ymax / 1000.0) * image_height_px,
    ]


class MockAnchorExtractor:
    """Deterministic offline anchor extractor used in tests and as a default."""

    provider_name = "mock"

    def extract(
        self,
        image: Image.Image,
        anchor_classes: list[AnchorClass],
        hints: AnchorHints,
    ) -> AnchorExtractionResult:
        # Place a small grid of synthetic anchors per requested class so that
        # downstream candidate scoring has stable, predictable inputs.
        anchors: list[SemanticAnchor] = []
        for cls_index, anchor_class in enumerate(anchor_classes):
            for i in range(3):
                y_norm = 400 + cls_index * 80
                x_norm = 200 + i * 200
                anchors.append(
                    SemanticAnchor(
                        id=f"mock_{anchor_class}_{i + 1:02d}",
                        **{"class": anchor_class},  # alias
                        label=f"{anchor_class}.{i + 1}",
                        point_norm=[y_norm, x_norm],
                        point_px=_norm_point_to_px(
                            [y_norm, x_norm],
                            hints.image_width_px,
                            hints.image_height_px,
                        ),
                        provider="mock",
                        semantic_confidence=0.6,
                    )
                )
        return AnchorExtractionResult(
            anchors=anchors,
            audit=AnchorAudit(
                provider="mock",
                model="mock-anchors-v1",
                prompt_count=len(anchor_classes),
                available=True,
            ),
        )


# Type alias for an injectable model call. Takes ``(image, prompt)`` and returns
# the model's raw text response. Tests inject a fake; production wires Gemini.
ModelCallable = Callable[[Image.Image, str], str]


def _strip_json_fence(text: str) -> str:
    """Return the JSON payload from a possibly fenced ``\u0060\u0060\u0060json`` block."""
    lines = text.splitlines()
    for i, line in enumerate(lines):
        if line.strip().startswith("```json"):
            remainder = "\n".join(lines[i + 1:])
            return remainder.split("```")[0]
        if line.strip().startswith("```"):
            remainder = "\n".join(lines[i + 1:])
            return remainder.split("```")[0]
    return text


class GeminiErAnchorExtractor:
    """Gemini Robotics-ER 1.5 anchor extractor.

    Fans out one pointing prompt per anchor class in parallel (matching the
    cookbook recommendation) and merges the results into a single list of
    :class:`SemanticAnchor` records with normalized and pixel coordinates.

    The Gemini call is supplied via ``model_call`` so the same logic can be
    contract-tested without network or SDK dependencies.
    """

    provider_name = "gemini_er"

    def __init__(
        self,
        *,
        model_call: ModelCallable,
        model_name: str = "gemini-robotics-er-1.5-preview",
        max_workers: int = 4,
    ) -> None:
        self._model_call = model_call
        self._model_name = model_name
        self._max_workers = max_workers
        self._live_calls = 0
        self._errors: list[str] = []

    def extract(
        self,
        image: Image.Image,
        anchor_classes: list[AnchorClass],
        hints: AnchorHints,
    ) -> AnchorExtractionResult:
        prompts: list[tuple[AnchorClass, str]] = [
            (
                cls,
                POINT_PROMPT_TEMPLATE.format(object_query=ANCHOR_QUERIES[cls]),
            )
            for cls in anchor_classes
            if cls in ANCHOR_QUERIES
        ]

        anchors: list[SemanticAnchor] = []

        def _one(item: tuple[AnchorClass, str]) -> list[SemanticAnchor]:
            cls, prompt = item
            try:
                self._live_calls += 1
                raw = self._model_call(image, prompt)
            except Exception as exc:  # pragma: no cover - defensive
                self._errors.append(f"{cls}: {exc}")
                return []
            return _parse_pointing_response(
                raw,
                anchor_class=cls,
                image_width_px=hints.image_width_px,
                image_height_px=hints.image_height_px,
            )

        if self._max_workers > 1 and len(prompts) > 1:
            with concurrent.futures.ThreadPoolExecutor(
                max_workers=self._max_workers
            ) as executor:
                for batch in executor.map(_one, prompts):
                    anchors.extend(batch)
        else:
            for item in prompts:
                anchors.extend(_one(item))

        return AnchorExtractionResult(
            anchors=anchors,
            audit=AnchorAudit(
                provider="gemini_er",
                model=self._model_name,
                prompt_count=len(prompts),
                live_calls=self._live_calls,
                available=not self._errors,
                errors=self._errors,
            ),
        )


def _parse_pointing_response(
    raw: str,
    *,
    anchor_class: AnchorClass,
    image_width_px: int,
    image_height_px: int,
) -> list[SemanticAnchor]:
    payload = _strip_json_fence(raw).strip()
    if not payload:
        return []
    try:
        data: Any = json.loads(payload)
    except json.JSONDecodeError:
        return []
    if not isinstance(data, list):
        return []

    anchors: list[SemanticAnchor] = []
    for index, item in enumerate(data, start=1):
        if not isinstance(item, dict):
            continue
        point = item.get("point")
        bbox = item.get("box_2d")
        label = str(item.get("label", f"{anchor_class}.{index}"))

        point_norm: list[int] | None = None
        point_px: list[float] | None = None
        if (
            isinstance(point, list)
            and len(point) == 2
            and all(isinstance(v, (int, float)) for v in point)
        ):
            point_norm = [int(point[0]), int(point[1])]
            point_px = _norm_point_to_px(point_norm, image_width_px, image_height_px)

        bbox_norm: list[int] | None = None
        bbox_px: list[float] | None = None
        if (
            isinstance(bbox, list)
            and len(bbox) == 4
            and all(isinstance(v, (int, float)) for v in bbox)
        ):
            bbox_norm = [int(v) for v in bbox]
            bbox_px = _norm_bbox_to_px(bbox_norm, image_width_px, image_height_px)

        if point_norm is None and bbox_norm is None:
            continue

        anchors.append(
            SemanticAnchor(
                id=f"er_{anchor_class}_{index:02d}",
                **{"class": anchor_class},
                label=label,
                point_norm=point_norm,
                point_px=point_px,
                bbox_norm=bbox_norm,
                bbox_px=bbox_px,
                provider="gemini_er",
                semantic_confidence=float(item.get("confidence", 0.7)),
            )
        )
    return anchors
