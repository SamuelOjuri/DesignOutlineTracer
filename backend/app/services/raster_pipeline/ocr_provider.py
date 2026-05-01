from pathlib import Path
from typing import Protocol

from PIL import Image

from app.config import Settings
from app.models.raster import OcrAudit, OcrHints, RasterTextBlock


class OcrProvider(Protocol):
    @property
    def name(self) -> str: ...

    @property
    def model_name(self) -> str: ...

    def extract_text_blocks(self, image: Image.Image, hints: OcrHints) -> list[RasterTextBlock]: ...


class MockOcrProvider:
    name = "mock"
    model_name = "mock-raster-ocr-v1"

    def extract_text_blocks(self, image: Image.Image, hints: OcrHints) -> list[RasterTextBlock]:
        width, height = image.size
        specs = [
            ("rwp.1", [0.16, 0.65, 0.19, 0.67], "rwp_label"),
            ("rwp.2", [0.24, 0.79, 0.28, 0.81], "rwp_label"),
            ("rwp.3", [0.31, 0.79, 0.35, 0.81], "rwp_label"),
            ("rwp.4", [0.44, 0.72, 0.48, 0.74], "rwp_label"),
            ("rwp.5", [0.56, 0.72, 0.60, 0.74], "rwp_label"),
            ("Proprietary roof light", [0.78, 0.65, 0.86, 0.70], "rooflight_label"),
            (
                "Fall paths to be designed by tapered insulation manufacture design",
                [0.78, 0.58, 0.88, 0.64],
                "fall_path_note",
            ),
            ("1:50", [0.72, 0.93, 0.75, 0.95], "scale_text"),
            ("823-UA-CD-02-DR-A-102", [0.86, 0.95, 0.98, 0.97], "drawing_number"),
            ("P2", [0.86, 0.95, 0.88, 0.97], "revision"),
        ]
        blocks: list[RasterTextBlock] = []
        for index, (text, rel_bbox, text_class) in enumerate(specs, start=1):
            bbox = [
                int(rel_bbox[0] * width),
                int(rel_bbox[1] * height),
                int(rel_bbox[2] * width),
                int(rel_bbox[3] * height),
            ]
            blocks.append(
                RasterTextBlock(
                    id=f"ocr_{index:03d}",
                    text=text,
                    bbox_px=bbox,
                    bbox_1000=[int(value * 1000) for value in rel_bbox],
                    bbox_source="mock_ocr_estimated",
                    text_confidence=0.9,
                    bbox_confidence=0.75,
                    **{"class": text_class},
                    class_source=self.model_name,
                    class_confidence=0.9,
                    tile_id="full_image",
                )
            )
        return blocks


class GeminiOcrProvider:
    name = "gemini"

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.model_name = settings.gemini_ocr_model

    def extract_text_blocks(self, image: Image.Image, hints: OcrHints) -> list[RasterTextBlock]:
        if not self.settings.allow_live_ai_calls or not self.settings.google_api_key:
            raise RuntimeError("Gemini OCR requires ALLOW_LIVE_AI_CALLS=1 and GOOGLE_API_KEY")
        # Live OCR prompt wiring is intentionally explicit but not exercised in default tests.
        raise NotImplementedError(
            "Live Gemini OCR is gated and not enabled in offline Phase 7 tests"
        )


def get_ocr_provider(settings: Settings) -> OcrProvider:
    if settings.raster_ocr_provider == "gemini":
        return GeminiOcrProvider(settings)
    return MockOcrProvider()


def ocr_audit(provider: OcrProvider, tile_count: int) -> OcrAudit:
    return OcrAudit(
        provider=provider.name,
        model=provider.model_name,
        tile_count=tile_count,
        cache_hits=0,
        cache_misses=0,
        live_calls=0,
        budget_exceeded=False,
    )


def cache_dir(settings: Settings) -> Path:
    path = settings.ocr_cache_dir
    return path if path.is_absolute() else settings.storage_path / path
