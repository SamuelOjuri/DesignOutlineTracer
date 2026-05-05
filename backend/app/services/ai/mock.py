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
        is_coarse_fallback = selected.geometry_source == "coarse_semantic_search_area"
        confidence = _mock_confidence(selected, is_coarse_fallback)
        review_required = selected.review_required or is_coarse_fallback or confidence < 0.75
        reason = _mock_reason(selected, is_coarse_fallback, review_required)
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
    exportable_candidate = next(
        (
            candidate
            for candidate in candidate_document.candidate_regions
            if candidate.eligible_for_auto_export
            and candidate.geometry_source != "coarse_semantic_search_area"
        ),
        None,
    )
    if exportable_candidate is not None:
        return exportable_candidate
    return candidate_document.candidate_regions[0]


def _mock_confidence(candidate: CandidateRegion, is_coarse_fallback: bool) -> float:
    if is_coarse_fallback:
        return min(0.58, candidate.score)
    semantic_support = 0.0
    if candidate.features.contains_rooflights:
        semantic_support += 0.08
    if candidate.features.contains_rwp_labels:
        semantic_support += 0.08
    if candidate.features.near_tapered_insulation_note:
        semantic_support += 0.05
    confidence = max(candidate.score, candidate.geometry_confidence) + semantic_support
    if candidate.review_required or candidate.score < 0.75:
        confidence = min(confidence, 0.7)
    return round(max(0.45, min(0.9, confidence)), 2)


def _mock_reason(
    candidate: CandidateRegion,
    is_coarse_fallback: bool,
    review_required: bool,
) -> str:
    if is_coarse_fallback:
        return (
            "Only a coarse semantic search area was available; it is not CAD-final geometry and "
            "requires human review before export."
        )
    if review_required:
        return (
            f"Selected {candidate.id} as the best available linework-derived candidate, but "
            "quality warnings or incomplete semantic anchors require human review before export."
        )
    return (
        f"Selected {candidate.id} because it is linework-derived, exportable, and has the "
        "strongest combination of geometry validity and semantic roof-scope evidence."
    )
