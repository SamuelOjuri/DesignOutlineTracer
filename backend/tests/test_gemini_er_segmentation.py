from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from PIL import Image, ImageDraw

from app.config import Settings
from app.models.raster import SegmentationHints
from app.services.ai import gemini
from app.services.raster_pipeline.gemini_er import GeminiErSegmenter
from app.services.raster_pipeline.pipeline import _segmenter


@pytest.fixture
def er_settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        storage_root=tmp_path,
        segmentation_provider="gemini_er",
        gemini_er_model="configured-er-model",
        gemini_er_max_image_dimension=500,
        google_api_key="test-key",
        allow_live_ai_calls=True,
    )


@pytest.fixture
def fake_client(monkeypatch: pytest.MonkeyPatch) -> MagicMock:
    client = MagicMock()
    client.__enter__.return_value = client
    client.models.generate_content.return_value = SimpleNamespace(
        parsed={"regions": [{"box_2d": [180, 180, 820, 820], "confidence": 0.9}]}
    )
    monkeypatch.setattr(gemini, "_create_genai_client", lambda api_key: client)
    return client


def test_er_grounding_uses_image_contour_and_caches(
    er_settings: Settings, fake_client: MagicMock
) -> None:
    segmenter = _segmenter(er_settings)
    assert isinstance(segmenter, GeminiErSegmenter)
    hints = SegmentationHints(document_id="doc", source_file="roof.pdf")
    with Image.new("RGB", (1000, 1000), "white") as image:
        ImageDraw.Draw(image).rectangle((200, 200, 800, 800), outline="black", width=4)
        candidates = segmenter.segment(image, ["roof scope"], hints)
        cached = segmenter.segment(image, ["roof scope"], hints)

    assert len(candidates) == 1
    assert cached == candidates
    assert candidates[0].provider == "gemini_er"
    assert candidates[0].source == "gemini_er_grounded_opencv_contour"
    assert candidates[0].review_required is True
    assert candidates[0].bbox_px == pytest.approx([200, 200, 800, 800], abs=4)
    assert candidates[0].bbox_px != [180, 180, 820, 820]
    assert fake_client.models.generate_content.call_args.kwargs["model"] == "configured-er-model"
    assert segmenter.audit().live_calls == 1
    assert segmenter.audit().cache_hits == 1
    assert segmenter.audit().cache_misses == 1


def test_er_does_not_turn_a_box_into_an_unsupported_polygon(
    er_settings: Settings, fake_client: MagicMock
) -> None:
    with Image.new("RGB", (500, 500), "white") as image:
        results = GeminiErSegmenter(er_settings).segment(
            image, ["roof"], SegmentationHints(document_id="doc", source_file="roof.pdf")
        )
    assert results == []


def test_er_requires_live_opt_in(er_settings: Settings, fake_client: MagicMock) -> None:
    er_settings.allow_live_ai_calls = False
    with Image.new("RGB", (100, 100)) as image, pytest.raises(RuntimeError, match="ALLOW_LIVE"):
        GeminiErSegmenter(er_settings).segment(
            image, ["roof"], SegmentationHints(document_id="doc", source_file="roof.pdf")
        )
    fake_client.models.generate_content.assert_not_called()


def test_unknown_segmenter_is_rejected(er_settings: Settings) -> None:
    er_settings.segmentation_provider = "typo"
    with pytest.raises(ValueError, match="Unsupported segmentation provider"):
        _segmenter(er_settings)


@pytest.mark.parametrize("box_2d", [[500, 100, 200, 800], [0, 0, 1001, 900], [0, 0, 100]])
def test_er_rejects_invalid_boxes_without_caching(
    er_settings: Settings, fake_client: MagicMock, box_2d: list[int]
) -> None:
    fake_client.models.generate_content.return_value = SimpleNamespace(
        parsed={"regions": [{"box_2d": box_2d, "confidence": 0.9}]}
    )
    segmenter = GeminiErSegmenter(er_settings)
    with (
        Image.new("RGB", (100, 100)) as image,
        pytest.raises(RuntimeError, match="structured grounding response"),
    ):
        segmenter.segment(
            image, ["roof"], SegmentationHints(document_id="doc", source_file="roof.pdf")
        )
    assert segmenter.audit().live_calls == 1
    assert segmenter.audit().errors
    assert not list((er_settings.storage_path / er_settings.gemini_er_cache_dir).glob("*.json"))
