from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from PIL import Image

from app.config import Settings
from app.models.raster import OcrHints
from app.services.ai import gemini
from app.services.raster_pipeline.ocr_provider import (
    GeminiOcrProvider,
    cache_dir,
    get_ocr_provider,
    ocr_audit,
)


def test_gemini_ocr_calls_configured_model_and_parses_boxes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    client = MagicMock()
    client.__enter__.return_value = client
    client.models.generate_content.return_value = SimpleNamespace(
        parsed={
            "blocks": [
                {
                    "text": "RWP.1",
                    "box_2d": [100, 200, 300, 400],
                    "text_class": "rwp_label",
                    "confidence": 0.9,
                }
            ]
        }
    )
    monkeypatch.setattr(gemini, "_create_genai_client", lambda api_key: client)
    settings = Settings(
        _env_file=None,
        google_api_key="test-key",
        allow_live_ai_calls=True,
        gemini_ocr_model="configured-ocr-model",
        ocr_cache_dir=tmp_path / "ocr",
    )
    provider = GeminiOcrProvider(settings)
    hints = OcrHints(document_id="doc", source_file="roof.pdf", page_index=1, render_dpi=300)

    with Image.new("RGB", (1000, 500), "white") as image:
        blocks = provider.extract_text_blocks(image, hints)

    assert len(blocks) == 1
    assert blocks[0].text == "RWP.1"
    assert blocks[0].bbox_px == [200, 50, 400, 150]
    assert blocks[0].bbox_1000 == [200, 100, 400, 300]
    assert blocks[0].text_class == "rwp_label"
    assert blocks[0].class_source == "configured-ocr-model"
    assert client.models.generate_content.call_args.kwargs["model"] == "configured-ocr-model"


@pytest.fixture
def ocr_settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        google_api_key="test-key",
        allow_live_ai_calls=True,
        gemini_ocr_model="configured-ocr-model",
        ocr_cache_dir=tmp_path / "ocr",
    )


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    client = MagicMock()
    client.__enter__.return_value = client
    client.models.generate_content.return_value = SimpleNamespace(parsed={"blocks": []})
    monkeypatch.setattr(gemini, "_create_genai_client", lambda api_key: client)
    return client


def test_ocr_cache_and_audit_use_image_model_and_prompt(
    ocr_settings: Settings, fake_client: MagicMock
) -> None:
    hints = OcrHints(document_id="doc", source_file="roof.pdf", render_dpi=300)
    provider = GeminiOcrProvider(ocr_settings)
    with Image.new("RGB", (100, 100), "white") as image:
        assert provider.extract_text_blocks(image, hints) == []
        assert provider.extract_text_blocks(image, hints) == []
        assert ocr_audit(provider, 2).model_dump() == {
            "provider": "gemini",
            "model": "configured-ocr-model",
            "tile_count": 2,
            "live_calls": 1,
            "cache_hits": 1,
            "cache_misses": 1,
            "budget_exceeded": False,
        }
        hints.prompt_version = "changed-version"
        provider.extract_text_blocks(image, hints)
        image.putpixel((0, 0), (0, 0, 0))
        provider.extract_text_blocks(image, hints)
        ocr_settings.gemini_ocr_model = "another-model"
        GeminiOcrProvider(ocr_settings).extract_text_blocks(image, hints)
    assert fake_client.models.generate_content.call_count == 4


@pytest.mark.parametrize("allow_live, api_key", [(False, "test-key"), (True, None)])
def test_ocr_is_gated(
    ocr_settings: Settings, fake_client: MagicMock, allow_live: bool, api_key: str | None
) -> None:
    ocr_settings.allow_live_ai_calls = allow_live
    ocr_settings.google_api_key = api_key
    hints = OcrHints(document_id="doc", source_file="roof.pdf", render_dpi=300)
    with Image.new("RGB", (100, 100)) as image, pytest.raises(RuntimeError, match="ALLOW_LIVE"):
        GeminiOcrProvider(ocr_settings).extract_text_blocks(image, hints)
    fake_client.models.generate_content.assert_not_called()


@pytest.mark.parametrize(
    "payload",
    [
        {},
        {
            "blocks": [
                {
                    "text": "RWP",
                    "text_class": "unknown",
                    "confidence": 0.9,
                    "box_2d": [100, 100, 200, 200],
                }
            ]
        },
        {
            "blocks": [
                {
                    "text": "RWP",
                    "text_class": "rwp_label",
                    "confidence": 0.9,
                    "box_2d": [300, 100, 200, 200],
                }
            ]
        },
        {
            "blocks": [
                {
                    "text": "RWP",
                    "text_class": "rwp_label",
                    "confidence": 0.9,
                    "box_2d": [0, -10, 200, 200],
                }
            ]
        },
    ],
)
def test_invalid_ocr_responses_are_not_cached(
    ocr_settings: Settings, fake_client: MagicMock, payload: dict[str, object]
) -> None:
    fake_client.models.generate_content.return_value = SimpleNamespace(parsed=payload)
    hints = OcrHints(document_id="doc", source_file="roof.pdf", render_dpi=300)
    with (
        Image.new("RGB", (100, 100)) as image,
        pytest.raises(RuntimeError, match="structured OCR response"),
    ):
        GeminiOcrProvider(ocr_settings).extract_text_blocks(image, hints)
    assert not list(ocr_settings.ocr_cache_dir.glob("*.json"))


def test_ocr_api_errors_do_not_expose_response_or_credentials(
    ocr_settings: Settings, fake_client: MagicMock
) -> None:
    fake_client.models.generate_content.side_effect = RuntimeError(
        "secret-value from remote server"
    )
    hints = OcrHints(document_id="doc", source_file="roof.pdf", render_dpi=300)
    with Image.new("RGB", (100, 100)) as image, pytest.raises(RuntimeError) as error:
        GeminiOcrProvider(ocr_settings).extract_text_blocks(image, hints)
    assert "configured-ocr-model" in str(error.value)
    assert "secret-value" not in str(error.value)
    assert not list(ocr_settings.ocr_cache_dir.glob("*.json"))


def test_ocr_parses_text_json_and_recovers_from_corrupt_cache(
    ocr_settings: Settings, fake_client: MagicMock
) -> None:
    fake_client.models.generate_content.return_value = SimpleNamespace(text='{"blocks": []}')
    hints = OcrHints(document_id="doc", source_file="roof.pdf", render_dpi=300)
    with Image.new("RGB", (100, 100)) as image:
        GeminiOcrProvider(ocr_settings).extract_text_blocks(image, hints)
        path = next(ocr_settings.ocr_cache_dir.glob("*.json"))
        path.write_text("incomplete", encoding="utf-8")
        assert GeminiOcrProvider(ocr_settings).extract_text_blocks(image, hints) == []
    assert fake_client.models.generate_content.call_count == 2


def test_ocr_cache_directory_does_not_duplicate_storage_prefix() -> None:
    settings = Settings(
        _env_file=None, storage_root=Path("storage"), ocr_cache_dir=Path("storage/cache/ocr")
    )
    assert cache_dir(settings) == settings.storage_path / "cache" / "ocr"


def test_unknown_ocr_provider_is_rejected(ocr_settings: Settings) -> None:
    ocr_settings.raster_ocr_provider = "typo"
    with pytest.raises(ValueError, match="Unsupported raster OCR provider"):
        get_ocr_provider(ocr_settings)
