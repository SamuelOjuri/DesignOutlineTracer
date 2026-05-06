"""Phase 8 — Robotics-ER 1.5 semantic anchor extraction tests."""

from __future__ import annotations

import json
import textwrap

from PIL import Image

from app.models.anchors import AnchorHints
from app.services.raster_pipeline.er_anchors import (
    GeminiErAnchorExtractor,
    MockAnchorExtractor,
)


def _hints(width: int = 1000, height: int = 800) -> AnchorHints:
    return AnchorHints(
        document_id="doc-1",
        source_file="sample.pdf",
        image_width_px=width,
        image_height_px=height,
    )


def test_mock_extractor_returns_anchors_for_each_class() -> None:
    extractor = MockAnchorExtractor()

    result = extractor.extract(
        Image.new("RGB", (1000, 800), "white"),
        anchor_classes=["rwp", "rooflight", "fall_arrow"],
        hints=_hints(),
    )

    assert result.audit.provider == "mock"
    assert result.audit.prompt_count == 3
    assert {a.anchor_class for a in result.anchors} == {"rwp", "rooflight", "fall_arrow"}
    # Every anchor has both normalized and pixel coordinates.
    for anchor in result.anchors:
        assert anchor.point_norm is not None and len(anchor.point_norm) == 2
        assert anchor.point_px is not None and len(anchor.point_px) == 2
        assert 0 <= anchor.point_px[0] <= 1000
        assert 0 <= anchor.point_px[1] <= 800


def test_gemini_er_extractor_parses_pointing_response_in_pixel_space() -> None:
    width, height = 2000, 1000
    # Mimic Robotics-ER pointing JSON in [y, x] / 0-1000 normalized space, with
    # an answer for each prompted class. Wrap in a ```json fence on purpose so
    # the parser exercises the same fence stripping the cookbook uses.
    responses_by_class = {
        "rwp": textwrap.dedent(
            """\
            ```json
            [
              {"point": [500, 250], "label": "rwp.1"},
              {"point": [600, 750], "label": "rwp.2"}
            ]
            ```
            """
        ),
        "rooflight": json.dumps(
            [{"point": [400, 500], "label": "rooflight"}]
        ),
        "fall_arrow": "[]",  # Empty array, no anchors of this type.
    }

    captured_prompts: dict[str, str] = {}

    def fake_call(image: Image.Image, prompt: str) -> str:
        # Pick the response based on which class wording is in the prompt.
        for cls, response in responses_by_class.items():
            if cls.replace("_", " ") in prompt or cls in prompt:
                captured_prompts[cls] = prompt
                return response
        return "[]"

    extractor = GeminiErAnchorExtractor(model_call=fake_call, max_workers=1)
    result = extractor.extract(
        Image.new("RGB", (width, height), "white"),
        anchor_classes=["rwp", "rooflight", "fall_arrow"],
        hints=_hints(width, height),
    )

    by_class: dict[str, list] = {}
    for anchor in result.anchors:
        by_class.setdefault(anchor.anchor_class, []).append(anchor)

    assert len(by_class.get("rwp", [])) == 2
    assert len(by_class.get("rooflight", [])) == 1
    assert "fall_arrow" not in by_class

    rwp_first = by_class["rwp"][0]
    assert rwp_first.provider == "gemini_er"
    assert rwp_first.point_norm == [500, 250]
    # Normalized [500, 250] -> px [x=0.25*2000, y=0.5*1000] = [500, 500]
    assert rwp_first.point_px == [500.0, 500.0]
    assert rwp_first.label == "rwp.1"
    assert result.audit.live_calls == 3
    assert result.audit.prompt_count == 3
    assert result.audit.provider == "gemini_er"


def test_gemini_er_extractor_handles_invalid_json_without_raising() -> None:
    def fake_call(image: Image.Image, prompt: str) -> str:
        return "not json at all"

    extractor = GeminiErAnchorExtractor(model_call=fake_call, max_workers=1)
    result = extractor.extract(
        Image.new("RGB", (1000, 1000), "white"),
        anchor_classes=["rwp"],
        hints=_hints(1000, 1000),
    )

    assert result.anchors == []
    assert result.audit.provider == "gemini_er"
    assert result.audit.live_calls == 1
