import base64
import json
import urllib.error
import urllib.request
from io import BytesIO
from typing import Any, cast

from PIL import Image

from app.config import Settings
from app.models.raster import SegmentationAudit, SegmentationCandidate, SegmentationHints
from app.services.raster_pipeline.errors import FalconSegmentationUnavailable
from app.services.raster_pipeline.segmentation import Segmenter


class SelfHostedFalconSegmenter(Segmenter):
    provider_name = "self_hosted_falcon"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.errors: list[str] = []
        self.live_calls = 0

    def segment(
        self,
        image: Image.Image,
        prompts: list[str],
        hints: SegmentationHints,
    ) -> list[SegmentationCandidate]:
        if not self._ready():
            self.errors.append("Falcon service is not ready")
            raise FalconSegmentationUnavailable("Falcon Perception service is unavailable")

        results: list[SegmentationCandidate] = []
        for prompt in prompts[: self.settings.falcon_perception_max_prompts]:
            response = self._post_prediction(image, prompt)
            results.extend(_adapt_response(response, prompt))
        return results

    def audit(self) -> SegmentationAudit:
        return SegmentationAudit(
            provider=self.provider_name,
            base_url=self.settings.falcon_perception_base_url,
            model="falcon-perception",
            live_calls=self.live_calls,
            available=not self.errors,
            errors=self.errors,
        )

    def _ready(self) -> bool:
        if not self.settings.falcon_perception_base_url:
            return False
        try:
            with urllib.request.urlopen(
                f"{self.settings.falcon_perception_base_url.rstrip('/')}/v1/health",
                timeout=self.settings.falcon_perception_timeout_seconds,
            ) as response:
                payload = json.loads(response.read().decode("utf-8"))
            return bool(payload.get("ready", payload.get("status") == "ready"))
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
            self.errors.append(str(exc))
            return False

    def _post_prediction(self, image: Image.Image, prompt: str) -> dict[str, Any]:
        if not self.settings.falcon_perception_base_url:
            raise FalconSegmentationUnavailable("Falcon Perception base URL is not configured")
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        payload = {
            "image": {"base64": base64.b64encode(buffer.getvalue()).decode("ascii")},
            "query": prompt,
            "task": "segmentation",
            "min_image_size": self.settings.falcon_perception_min_image_dimension,
            "max_image_size": self.settings.falcon_perception_max_image_dimension,
        }
        request = urllib.request.Request(
            f"{self.settings.falcon_perception_base_url.rstrip('/')}/v1/predictions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        self.live_calls += 1
        with urllib.request.urlopen(
            request,
            timeout=self.settings.falcon_perception_timeout_seconds,
        ) as response:
            return cast(dict[str, Any], json.loads(response.read().decode("utf-8")))


def _adapt_response(response: dict[str, Any], prompt: str) -> list[SegmentationCandidate]:
    candidates: list[SegmentationCandidate] = []
    for index, mask in enumerate(response.get("masks", []), start=1):
        bbox = [float(value) for value in mask.get("bbox", [0, 0, 0, 0])]
        polygon = mask.get("polygon") or [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[2], bbox[3]],
            [bbox[0], bbox[3]],
        ]
        candidates.append(
            SegmentationCandidate(
                id=f"falcon_candidate_{index:02d}",
                source="falcon_perception_candidate_mask",
                provider="self_hosted_falcon",
                prompt=prompt,
                bbox_px=bbox,
                polygon_px=polygon,
                mask_area_px=max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])),
                geometry_confidence=0.62,
            )
        )
    return candidates
