from typing import Protocol

from app.models.vector import ClassifiedTextBlock, TextBlock


class AiProvider(Protocol):
    """Common interface for model-backed semantic helpers."""

    @property
    def name(self) -> str: ...

    def classify_text_blocks(self, text_blocks: list[TextBlock]) -> list[ClassifiedTextBlock]: ...
