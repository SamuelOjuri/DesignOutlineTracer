import json

from PIL import Image

from app.config import Settings
from app.models.raster import OcrHints
from app.services.raster_pipeline.ocr_merge import merge_ocr_blocks
from app.services.raster_pipeline.ocr_provider import GeminiOcrProvider, MockOcrProvider, ocr_audit


def test_mock_ocr_returns_deterministic_text_blocks() -> None:
    provider = MockOcrProvider()
    blocks = provider.extract_text_blocks(
        Image.new("RGB", (2000, 1000), "white"),
        OcrHints(document_id="doc", source_file="sample.pdf", render_dpi=300),
    )

    assert any(block.text == "rwp.1" for block in blocks)
    assert any(block.text_class == "scale_text" for block in blocks)
    assert all(block.bbox_px[2] > block.bbox_px[0] for block in blocks)


def test_ocr_merge_deduplicates_overlapping_text() -> None:
    provider = MockOcrProvider()
    blocks = provider.extract_text_blocks(
        Image.new("RGB", (2000, 1000), "white"),
        OcrHints(document_id="doc", source_file="sample.pdf", render_dpi=300),
    )

    merged = merge_ocr_blocks([blocks[0], blocks[0].model_copy(update={"id": "dup"})])

    assert len(merged) == 1


def test_gemini_ocr_provider_parses_json_text_blocks() -> None:
    captured: dict[str, object] = {}
    raw_response = json.dumps(
        {
            "text_blocks": [
                {
                    "text": "rwp.1",
                    "bbox_1000": [100, 200, 300, 240],
                    "class": "rainwater_outlet",
                    "confidence": 0.88,
                    "bbox_confidence": 0.82,
                },
                {
                    "text": "Proprietary roof light",
                    "box_2d": [650, 780, 700, 860],
                    "class": "roof_light",
                    "text_confidence": 0.91,
                    "class_confidence": 0.86,
                },
            ]
        }
    )

    def fake_call(image: Image.Image, prompt: str) -> str:
        captured["size"] = image.size
        captured["prompt"] = prompt
        return f"```json\n{raw_response}\n```"

    provider = GeminiOcrProvider(
        Settings(
            raster_ocr_provider="gemini",
            allow_live_ai_calls=True,
            google_api_key="test-key",
            gemini_ocr_model="gemini-3-flash-preview",
        ),
        model_call=fake_call,
    )
    blocks = provider.extract_text_blocks(
        Image.new("RGB", (2000, 1000), "white"),
        OcrHints(document_id="doc", source_file="sample.pdf", render_dpi=300),
    )

    assert captured["size"] == (2000, 1000)
    assert "bbox_1000" in str(captured["prompt"])
    assert len(blocks) == 2
    assert blocks[0].text == "rwp.1"
    assert blocks[0].text_class == "rwp_label"
    assert blocks[0].bbox_px == [200, 200, 600, 240]
    assert blocks[0].text_confidence == 0.88
    assert blocks[1].text_class == "rooflight_label"
    assert blocks[1].bbox_1000 == [780, 650, 860, 700]
    assert provider.live_calls == 1
    assert ocr_audit(provider, tile_count=1).live_calls == 1


def test_gemini_ocr_provider_returns_empty_for_invalid_json() -> None:
    provider = GeminiOcrProvider(
        Settings(
            raster_ocr_provider="gemini",
            allow_live_ai_calls=True,
            google_api_key="test-key",
        ),
        model_call=lambda image, prompt: "not json",
    )

    blocks = provider.extract_text_blocks(
        Image.new("RGB", (1000, 1000), "white"),
        OcrHints(document_id="doc", source_file="sample.pdf", render_dpi=300),
    )

    assert blocks == []
    assert provider.live_calls == 1
