"""Phase 8 — Robotics-ER 1.5 segmentation contract tests."""

from __future__ import annotations

import base64
import io
import json
from pathlib import Path

from PIL import Image

from app.config import Settings
from app.models.raster import SegmentationHints
from app.services.raster_pipeline.er_segmentation import GeminiErSegmenter
from app.services.raster_pipeline.pipeline import _segmenter


def _png_mask_data_uri(width: int, height: int) -> str:
    """Return a base64 data URI for a mask that fills the whole box."""
    image = Image.new("L", (width, height), 255)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def test_gemini_er_segmenter_decodes_box_and_mask_into_pixel_space() -> None:
    width, height = 2000, 1000
    response_payload = [
        {
            "box_2d": [200, 100, 800, 500],  # ymin, xmin, ymax, xmax
            "label": "proposed flat roof area",
            "mask": _png_mask_data_uri(64, 64),
        }
    ]
    raw_response = "```json\n" + json.dumps(response_payload) + "\n```"

    captured: dict[str, object] = {}

    def fake_call(image: Image.Image, prompt: str) -> str:
        captured["prompt"] = prompt
        captured["size"] = image.size
        return raw_response

    segmenter = GeminiErSegmenter(model_call=fake_call)

    candidates = segmenter.segment(
        Image.new("RGB", (width, height), "white"),
        prompts=[],
        hints=SegmentationHints(document_id="d", source_file="s.pdf"),
    )

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.provider == "gemini_er"
    assert candidate.source == "gemini_er_mask_region"
    # ymin=200, xmin=100, ymax=800, xmax=500 normalized 0-1000 in (2000, 1000)
    # -> bbox_px = [xmin=200, ymin=200, xmax=1000, ymax=800]
    assert candidate.bbox_px == [200.0, 200.0, 1000.0, 800.0]
    # Polygon should fall inside (or on) the box.
    for x_value, y_value in candidate.polygon_px:
        assert 200.0 <= x_value <= 1000.0
        assert 200.0 <= y_value <= 800.0
    # Mask area equals box area.
    assert candidate.mask_area_px == 800.0 * 600.0

    audit = segmenter.audit()
    assert audit.provider == "gemini_er"
    assert audit.live_calls == 1
    assert audit.available is True


def test_gemini_er_segmenter_adapts_point_only_response_to_anchor() -> None:
    raw_response = """```json
[
  {"point": [678, 290], "label": "proposed flat roof area requiring tapered insulation"}
]
```"""

    def fake_call(image: Image.Image, prompt: str) -> str:
        return raw_response

    segmenter = GeminiErSegmenter(model_call=fake_call)
    candidates = segmenter.segment(
        Image.new("RGB", (9934, 7017), "white"),
        prompts=["segment roof"],
        hints=SegmentationHints(document_id="d", source_file="s.pdf"),
    )

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.id == "gemini_er_point_anchor_01"
    assert candidate.type == "point_anchor"
    assert candidate.source == "gemini_er_point_anchor"
    assert candidate.label == "proposed flat roof area requiring tapered insulation"
    assert candidate.point_norm == [678, 290]
    assert [round(value, 3) for value in candidate.point_px or []] == [2880.86, 4757.526]
    assert candidate.review_required is True


def test_gemini_er_segmenter_writes_raw_response_debug_file(tmp_path: Path) -> None:
    raw_response = json.dumps(
        [{"box_2d": [100, 100, 500, 500], "label": "roof area"}]
    )

    def fake_call(image: Image.Image, prompt: str) -> str:
        return raw_response

    segmenter = GeminiErSegmenter(model_call=fake_call)
    candidates = segmenter.segment(
        Image.new("RGB", (1000, 1000), "white"),
        prompts=["segment roof"],
        hints=SegmentationHints(
            document_id="d",
            source_file="s.pdf",
            debug_dir_path=str(tmp_path),
        ),
    )

    assert candidates
    audit = segmenter.audit()
    assert audit.raw_response_path is not None
    raw_path = Path(audit.raw_response_path)
    assert raw_path.name == "gemini_er_segmentation_raw_response.txt"
    assert raw_path.read_text(encoding="utf-8") == raw_response
    assert audit.raw_response_preview == raw_response


def test_gemini_er_segmenter_returns_empty_when_response_is_invalid() -> None:
    def fake_call(image: Image.Image, prompt: str) -> str:
        return "not json"

    segmenter = GeminiErSegmenter(model_call=fake_call)
    candidates = segmenter.segment(
        Image.new("RGB", (500, 500), "white"),
        prompts=[],
        hints=SegmentationHints(document_id="d", source_file="s.pdf"),
    )

    assert candidates == []
    assert segmenter.audit().live_calls == 1


def test_gemini_er_segmenter_keeps_invalid_raw_response_preview(tmp_path: Path) -> None:
    raw_response = "Gemini returned prose instead of JSON"

    def fake_call(image: Image.Image, prompt: str) -> str:
        return raw_response

    segmenter = GeminiErSegmenter(model_call=fake_call)
    candidates = segmenter.segment(
        Image.new("RGB", (500, 500), "white"),
        prompts=[],
        hints=SegmentationHints(
            document_id="d",
            source_file="s.pdf",
            debug_dir_path=str(tmp_path),
        ),
    )

    assert candidates == []
    audit = segmenter.audit()
    assert audit.available is True
    assert audit.errors == []
    assert audit.raw_response_preview == raw_response
    assert audit.raw_response_path is not None
    assert Path(audit.raw_response_path).read_text(encoding="utf-8") == raw_response


def test_gemini_er_segmenter_falls_back_to_box_polygon_without_mask() -> None:
    response_payload = [
        {
            "box_2d": [100, 100, 500, 500],
            "label": "roof area",
            # No mask field provided.
        }
    ]

    def fake_call(image: Image.Image, prompt: str) -> str:
        return json.dumps(response_payload)

    segmenter = GeminiErSegmenter(model_call=fake_call)
    candidates = segmenter.segment(
        Image.new("RGB", (1000, 1000), "white"),
        prompts=[],
        hints=SegmentationHints(document_id="d", source_file="s.pdf"),
    )

    assert len(candidates) == 1
    candidate = candidates[0]
    assert candidate.source == "gemini_er_box_region"
    # Polygon is the four box corners when no mask is provided.
    assert candidate.polygon_px == [
        [100.0, 100.0],
        [500.0, 100.0],
        [500.0, 500.0],
        [100.0, 500.0],
    ]


def test_raster_pipeline_factory_wires_gemini_er_segmenter(monkeypatch: object) -> None:
    calls: list[dict[str, object]] = []

    def fake_builder(**kwargs: object):
        calls.append(kwargs)

        def fake_call(image: Image.Image, prompt: str) -> str:
            return json.dumps([
                {"box_2d": [100, 100, 500, 500], "label": "roof area"}
            ])

        return fake_call

    monkeypatch.setattr(
        "app.services.raster_pipeline.pipeline.build_gemini_er_model_call",
        fake_builder,
    )

    segmenter = _segmenter(
        Settings(
            segmentation_provider="gemini_er",
            allow_live_ai_calls=True,
            google_api_key="test-key",
            gemini_er_model="gemini-robotics-er-1.5-preview",
        )
    )
    candidates = segmenter.segment(
        Image.new("RGB", (1000, 1000), "white"),
        prompts=["segment roof"],
        hints=SegmentationHints(document_id="d", source_file="s.pdf"),
    )

    assert candidates[0].provider == "gemini_er"
    assert calls == [
        {
            "api_key": "test-key",
            "model_name": "gemini-robotics-er-1.5-preview",
        }
    ]


def test_raster_pipeline_factory_gates_gemini_er_live_calls() -> None:
    segmenter = _segmenter(
        Settings(
            segmentation_provider="gemini_er",
            allow_live_ai_calls=False,
            google_api_key=None,
        )
    )

    candidates = segmenter.segment(
        Image.new("RGB", (1000, 1000), "white"),
        prompts=["segment roof"],
        hints=SegmentationHints(document_id="d", source_file="s.pdf"),
    )

    assert candidates == []
    audit = segmenter.audit()
    assert audit.provider == "gemini_er"
    assert audit.available is False
    assert "ALLOW_LIVE_AI_CALLS" in audit.errors[0]
