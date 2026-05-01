import re

from app.models.vector import ClassifiedTextBlock, TextBlock, TextBlockClass
from app.services.ai.provider import AiProvider


class MockProvider(AiProvider):
    """Deterministic offline provider used by default in tests."""

    @property
    def name(self) -> str:
        return "mock"

    def classify_text_blocks(self, text_blocks: list[TextBlock]) -> list[ClassifiedTextBlock]:
        return [
            ClassifiedTextBlock(
                id=text_block.id,
                text_class=_classify_text(text_block.text),
                semantic_confidence=0.9,
                class_source=self.name,
            )
            for text_block in text_blocks
        ]


def _classify_text(text: str) -> TextBlockClass:
    normalized = re.sub(r"\s+", " ", text.strip()).lower()

    if re.search(r"\brwp\.?\s*\d+\b", normalized):
        return "rwp_label"
    if re.search(r"\b1\s*:\s*\d+\b", normalized) or "scale 1:" in normalized:
        return "scale_text"
    if "roof plan" in normalized or "roof layout" in normalized:
        return "drawing_title"
    if "preliminary" in normalized or "drawing status" in normalized:
        return "drawing_status"
    if re.search(r"\b[A-Z0-9]{2,}[- ][A-Z0-9]{2,}[- ][A-Z0-9]{2,}", text):
        return "drawing_number"
    if re.search(r"\bP\d+\b|\bD\d+\b", text.strip()):
        return "revision"
    if "roof light" in normalized or "rooflight" in normalized:
        return "rooflight_label"
    if "tapered insulation" in normalized or "single-ply" in normalized:
        return "roof_build_up_note"
    if "fall path" in normalized or "downpipe" in normalized or "hopper" in normalized:
        return "fall_path_note"
    if any(token in normalized for token in ("client", "project", "drawing", "revision", "status")):
        return "title_block_text"
    if len(normalized) > 40:
        return "general_note"
    return "other"
