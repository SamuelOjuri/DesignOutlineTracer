import json
import textwrap
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol, cast, get_args

from PIL import Image

from app.config import Settings
from app.models.raster import OcrAudit, OcrHints, RasterTextBlock, RasterTextClass
from app.services.ai.google_genai import build_gemini_image_prompt_model_call

GeminiOcrModelCall = Callable[[Image.Image, str], str]

OCR_PROMPT_TEMPLATE = textwrap.dedent(
        """\
        Extract OCR text from this architectural roof plan image crop. Return only
        JSON in this exact shape:
        {{
            "text_blocks": [
                {{
                    "text": "<visible text>",
                    "bbox_1000": [xmin, ymin, xmax, ymax],
                    "class": "<one supported text class>",
                    "text_confidence": 0.0,
                    "bbox_confidence": 0.0,
                    "class_confidence": 0.0
                }}
            ]
        }}

        Supported text classes: rwp_label, scale_text, fall_path_note,
        title_block_text, roof_build_up_note, rooflight_label, drawing_number,
        revision, status, legend_text, general_note, dimension_text, other.

        bbox_1000 coordinates are relative to the supplied image crop, normalized
        to 0-1000 in [xmin, ymin, xmax, ymax] order. Include visible roof-plan
        labels such as RWP labels, scale text, drawing numbers, revisions,
        rooflight labels, fall notes, roof build-up notes, dimensions, legends,
        and general notes. Do not invent text that is not visible. If no text is
        legible, return {{"text_blocks": []}}.

        Source file: {source_file}
        Document id: {document_id}
        Page index: {page_index}
        Render DPI: {render_dpi}
        Prompt version: {prompt_version}
        """
)

VALID_TEXT_CLASSES = set(get_args(RasterTextClass))


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

    def __init__(
        self,
        settings: Settings,
        *,
        model_call: GeminiOcrModelCall | None = None,
    ) -> None:
        self.settings = settings
        self.model_name = settings.gemini_ocr_model
        self._model_call = model_call
        self.live_calls = 0

    def extract_text_blocks(self, image: Image.Image, hints: OcrHints) -> list[RasterTextBlock]:
        model_call = self._model_call or self._build_model_call()
        self.live_calls += 1
        raw = model_call(image, _build_ocr_prompt(hints))
        return _parse_gemini_ocr_response(
            raw,
            image_size=image.size,
            model_name=self.model_name,
        )

    def _build_model_call(self) -> GeminiOcrModelCall:
        if not self.settings.allow_live_ai_calls or not self.settings.google_api_key:
            raise RuntimeError("Gemini OCR requires ALLOW_LIVE_AI_CALLS=1 and GOOGLE_API_KEY")
        self._model_call = build_gemini_image_prompt_model_call(
            api_key=self.settings.google_api_key,
            model_name=self.model_name,
            temperature=0.1,
            response_mime_type="application/json",
        )
        return self._model_call


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
        live_calls=int(getattr(provider, "live_calls", 0)),
        budget_exceeded=False,
    )


def cache_dir(settings: Settings) -> Path:
    path = settings.ocr_cache_dir
    return path if path.is_absolute() else settings.storage_path / path


def _build_ocr_prompt(hints: OcrHints) -> str:
    return OCR_PROMPT_TEMPLATE.format(
        source_file=hints.source_file,
        document_id=hints.document_id,
        page_index=hints.page_index,
        render_dpi=hints.render_dpi,
        prompt_version=hints.prompt_version,
    )


def _strip_json_fence(text: str) -> str:
    lines = text.splitlines()
    for index, line in enumerate(lines):
        if line.strip().startswith("```"):
            remainder = "\n".join(lines[index + 1:])
            return remainder.split("```")[0]
    return text


def _parse_gemini_ocr_response(
    raw: str,
    *,
    image_size: tuple[int, int],
    model_name: str,
) -> list[RasterTextBlock]:
    payload_text = _strip_json_fence(raw).strip()
    if not payload_text:
        return []
    try:
        payload: Any = json.loads(payload_text)
    except json.JSONDecodeError:
        return []

    if isinstance(payload, dict):
        block_payload = payload.get("text_blocks", payload.get("blocks", []))
    else:
        block_payload = payload
    if not isinstance(block_payload, list):
        return []

    blocks: list[RasterTextBlock] = []
    for index, item in enumerate(block_payload, start=1):
        if not isinstance(item, dict):
            continue
        block = _adapt_gemini_ocr_block(
            item,
            index=index,
            image_size=image_size,
            model_name=model_name,
        )
        if block is not None:
            blocks.append(block)
    return blocks


def _adapt_gemini_ocr_block(
    item: dict[str, Any],
    *,
    index: int,
    image_size: tuple[int, int],
    model_name: str,
) -> RasterTextBlock | None:
    text = str(item.get("text", "")).strip()
    if not text:
        return None

    bbox_1000 = _bbox_1000_from_item(item, image_size=image_size)
    if bbox_1000 is None:
        return None
    xmin, ymin, xmax, ymax = bbox_1000
    if xmax <= xmin or ymax <= ymin:
        return None

    width_px, height_px = image_size
    bbox_px = [
        round((xmin / 1000.0) * width_px),
        round((ymin / 1000.0) * height_px),
        round((xmax / 1000.0) * width_px),
        round((ymax / 1000.0) * height_px),
    ]
    if bbox_px[2] <= bbox_px[0] or bbox_px[3] <= bbox_px[1]:
        return None

    return RasterTextBlock(
        id=f"ocr_{index:03d}",
        text=text,
        bbox_px=bbox_px,
        bbox_1000=bbox_1000,
        bbox_source="gemini_ocr_normalized",
        text_confidence=_confidence(item, "text_confidence", fallback_key="confidence"),
        bbox_confidence=_confidence(item, "bbox_confidence", fallback=0.7),
        **{"class": _normalize_text_class(item, text)},
        class_source=model_name,
        class_confidence=_confidence(item, "class_confidence", fallback=0.7),
        tile_id=None,
    )


def _bbox_1000_from_item(
    item: dict[str, Any],
    *,
    image_size: tuple[int, int],
) -> list[int] | None:
    bbox = item.get("bbox_1000") or item.get("bbox")
    if _is_number_list(bbox, expected_length=4):
        return [_norm_1000(value) for value in cast(list[int | float], bbox)]

    box_2d = item.get("box_2d")
    if _is_number_list(box_2d, expected_length=4):
        ymin, xmin, ymax, xmax = cast(list[int | float], box_2d)
        return [_norm_1000(xmin), _norm_1000(ymin), _norm_1000(xmax), _norm_1000(ymax)]

    bbox_px = item.get("bbox_px")
    if _is_number_list(bbox_px, expected_length=4):
        width_px, height_px = image_size
        x0, y0, x1, y1 = cast(list[int | float], bbox_px)
        return [
            _norm_1000((x0 / width_px) * 1000),
            _norm_1000((y0 / height_px) * 1000),
            _norm_1000((x1 / width_px) * 1000),
            _norm_1000((y1 / height_px) * 1000),
        ]
    return None


def _is_number_list(value: Any, *, expected_length: int) -> bool:
    return (
        isinstance(value, list)
        and len(value) == expected_length
        and all(isinstance(item, (int, float)) for item in value)
    )


def _norm_1000(value: int | float) -> int:
    return int(round(max(0.0, min(1000.0, float(value)))))


def _confidence(
    item: dict[str, Any],
    key: str,
    *,
    fallback_key: str | None = None,
    fallback: float = 0.75,
) -> float:
    value = item.get(key)
    if value is None and fallback_key is not None:
        value = item.get(fallback_key)
    if not isinstance(value, (int, float)):
        value = fallback
    return max(0.0, min(1.0, float(value)))


def _normalize_text_class(item: dict[str, Any], text: str) -> RasterTextClass:
    raw = str(item.get("class", item.get("text_class", ""))).strip().lower()
    normalized = raw.replace("-", "_").replace(" ", "_")
    aliases = {
        "rwp": "rwp_label",
        "rainwater_outlet": "rwp_label",
        "rainwater_outlet_label": "rwp_label",
        "roof_light": "rooflight_label",
        "rooflight": "rooflight_label",
        "scale": "scale_text",
        "drawing_no": "drawing_number",
        "drawing_number_text": "drawing_number",
        "rev": "revision",
        "fall_note": "fall_path_note",
        "fall_arrow": "fall_path_note",
        "build_up_note": "roof_build_up_note",
        "legend": "legend_text",
        "dimension": "dimension_text",
    }
    normalized = aliases.get(normalized, normalized)
    if normalized in VALID_TEXT_CLASSES:
        return cast(RasterTextClass, normalized)

    text_lower = text.lower()
    if text_lower.startswith("rwp") or "rainwater" in text_lower:
        return "rwp_label"
    if "rooflight" in text_lower or "roof light" in text_lower:
        return "rooflight_label"
    if "1:" in text_lower or "scale" in text_lower:
        return "scale_text"
    if "fall" in text_lower:
        return "fall_path_note"
    return "other"
