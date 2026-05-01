from typing import Protocol

from app.models.candidates import CandidateDocument
from app.models.validation import SemanticValidationResult
from app.models.vector import ClassifiedTextBlock, TextBlock


class AiProvider(Protocol):
    """Common interface for model-backed semantic helpers."""

    @property
    def name(self) -> str: ...

    def classify_text_blocks(self, text_blocks: list[TextBlock]) -> list[ClassifiedTextBlock]: ...

    def validate_candidates(
        self,
        *,
        candidate_document: CandidateDocument,
        text_blocks: list[TextBlock],
        overlay_png_path: str | None,
    ) -> SemanticValidationResult: ...
