import re

from app.models.candidates import CandidateDocument, CandidateRegion
from app.models.validation import SemanticValidationResult
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

    def validate_candidates(
        self,
        *,
        candidate_document: CandidateDocument,
        text_blocks: list[TextBlock],
        overlay_png_path: str | None,
    ) -> SemanticValidationResult:
        selected = _select_mock_candidate(candidate_document)
        has_semantic_scope = selected.geometry_source == "semantic_roof_scope_envelope"
        confidence = 0.92 if has_semantic_scope else 0.62
        review_required = not has_semantic_scope
        reason = _mock_reason(selected, has_semantic_scope)
        return SemanticValidationResult(
            selected_candidate_id=selected.id,
            reason=reason,
            confidence=confidence,
            review_required=review_required,
            provider=self.name,
            model="mock-deterministic-v1",
            escalation_used=False,
        )


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


def _select_mock_candidate(candidate_document: CandidateDocument) -> CandidateRegion:
    semantic_candidate = next(
        (
            candidate
            for candidate in candidate_document.candidate_regions
            if candidate.geometry_source == "semantic_roof_scope_envelope"
        ),
        None,
    )
    if semantic_candidate is not None:
        return semantic_candidate
    return candidate_document.candidate_regions[0]


def _mock_reason(candidate: CandidateRegion, has_semantic_scope: bool) -> str:
    if has_semantic_scope:
        return (
            "Selected deterministic roof-scope candidate because it contains rooflight "
            f"geometry, {candidate.features.rwp_label_count} RWP labels, and fall/tapered notes "
            "while excluding title-block metadata."
        )
    return (
        "Selected top-ranked vector candidate, but semantic roof-scope anchors were incomplete; "
        "human review is required before geometry finalisation."
    )
