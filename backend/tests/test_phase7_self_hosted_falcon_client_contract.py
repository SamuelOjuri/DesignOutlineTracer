import json
from typing import Any

from PIL import Image

from app.config import Settings
from app.models.raster import SegmentationHints
from app.services.raster_pipeline.falcon_perception import SelfHostedFalconSegmenter


class FakeResponse:
    def __init__(self, payload: dict[str, Any]) -> None:
        self.payload = payload

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *args: object) -> None:
        return None

    def read(self) -> bytes:
        return json.dumps(self.payload).encode("utf-8")


def test_self_hosted_falcon_client_builds_health_and_prediction_calls(monkeypatch: Any) -> None:
    calls: list[str] = []

    def fake_urlopen(request: Any, timeout: int) -> FakeResponse:
        url = request if isinstance(request, str) else request.full_url
        calls.append(url)
        if url.endswith("/v1/health"):
            return FakeResponse({"ready": True})
        return FakeResponse({"masks": [{"bbox": [1, 2, 10, 20]}]})

    monkeypatch.setattr("urllib.request.urlopen", fake_urlopen)
    segmenter = SelfHostedFalconSegmenter(
        Settings(falcon_perception_base_url="http://localhost:7860")
    )

    candidates = segmenter.segment(
        Image.new("RGB", (50, 50), "white"),
        prompts=["segment roof"],
        hints=SegmentationHints(document_id="doc", source_file="sample.pdf"),
    )

    assert calls == ["http://localhost:7860/v1/health", "http://localhost:7860/v1/predictions"]
    assert candidates[0].provider == "self_hosted_falcon"
