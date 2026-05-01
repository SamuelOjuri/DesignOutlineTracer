from typing import Protocol

from PIL import Image

from app.models.raster import (
    SegmentationAudit,
    SegmentationCandidate,
    SegmentationHints,
)


class Segmenter(Protocol):
    @property
    def provider_name(self) -> str: ...

    def segment(
        self,
        image: Image.Image,
        prompts: list[str],
        hints: SegmentationHints,
    ) -> list[SegmentationCandidate]: ...

    def audit(self) -> SegmentationAudit: ...


class NoopSegmenter:
    provider_name = "noop"

    def segment(
        self,
        image: Image.Image,
        prompts: list[str],
        hints: SegmentationHints,
    ) -> list[SegmentationCandidate]:
        return []

    def audit(self) -> SegmentationAudit:
        return SegmentationAudit(provider="noop", available=False)


class MockSegmenter:
    provider_name = "mock"

    def segment(
        self,
        image: Image.Image,
        prompts: list[str],
        hints: SegmentationHints,
    ) -> list[SegmentationCandidate]:
        width, height = image.size
        bbox = [width * 0.12, height * 0.18, width * 0.74, height * 0.84]
        polygon = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]]
        return [
            SegmentationCandidate(
                id="falcon_candidate_mock_01",
                source="falcon_perception_candidate_mask",
                provider="mock",
                prompt=prompts[0] if prompts else "mock",
                bbox_px=bbox,
                polygon_px=polygon,
                mask_area_px=(bbox[2] - bbox[0]) * (bbox[3] - bbox[1]),
                geometry_confidence=0.62,
            )
        ]

    def audit(self) -> SegmentationAudit:
        return SegmentationAudit(
            provider="mock",
            model="mock-segmentation-v1",
            prompt_count=1,
            available=True,
        )


class FutureManagedApiSegmenter(NoopSegmenter):
    provider_name = "future_api"
