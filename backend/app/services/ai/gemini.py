import json
from pathlib import Path
from typing import Any, cast

from app.models.candidates import CandidateDocument
from app.models.validation import SemanticValidationResult
from app.models.vector import ClassifiedTextBlock, TextBlock
from app.services.ai.mock import MockProvider
from app.services.ai.provider import AiProvider

VALIDATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "selected_candidate_id": {"type": "string"},
        "reason": {"type": "string"},
        "confidence": {"type": "number"},
        "review_required": {"type": "boolean"},
    },
    "required": ["selected_candidate_id", "reason", "confidence", "review_required"],
}


class GeminiProvider(AiProvider):
    def __init__(
        self,
        *,
        api_key: str,
        flash_model: str = "gemini-2.5-flash",
        pro_model: str = "gemini-2.5-pro",
        allow_pro_escalation: bool = False,
        pro_escalation_confidence_threshold: float = 0.75,
    ) -> None:
        self.api_key = api_key
        self.flash_model = flash_model
        self.pro_model = pro_model
        self.allow_pro_escalation = allow_pro_escalation
        self.pro_escalation_confidence_threshold = pro_escalation_confidence_threshold
        self._mock_text_classifier = MockProvider()

    @property
    def name(self) -> str:
        return "gemini"

    def classify_text_blocks(self, text_blocks: list[TextBlock]) -> list[ClassifiedTextBlock]:
        # Phase 4 uses Gemini for validation; text classification stays deterministic.
        return self._mock_text_classifier.classify_text_blocks(text_blocks)

    def validate_candidates(
        self,
        *,
        candidate_document: CandidateDocument,
        text_blocks: list[TextBlock],
        overlay_png_path: str | None,
    ) -> SemanticValidationResult:
        first_pass = self._run_validation_model(
            model_name=self.flash_model,
            candidate_document=candidate_document,
            text_blocks=text_blocks,
            overlay_png_path=overlay_png_path,
        )
        if (
            first_pass.confidence >= self.pro_escalation_confidence_threshold
            and not first_pass.review_required
        ):
            return first_pass
        if not self.allow_pro_escalation:
            return first_pass

        escalated = self._run_validation_model(
            model_name=self.pro_model,
            candidate_document=candidate_document,
            text_blocks=text_blocks,
            overlay_png_path=overlay_png_path,
        )
        return escalated.model_copy(update={"escalation_used": True})

    def _run_validation_model(
        self,
        *,
        model_name: str,
        candidate_document: CandidateDocument,
        text_blocks: list[TextBlock],
        overlay_png_path: str | None,
    ) -> SemanticValidationResult:
        import google.generativeai as genai

        genai.configure(api_key=self.api_key)  # type: ignore[attr-defined]
        model = genai.GenerativeModel(model_name)  # type: ignore[attr-defined]
        prompt = _build_validation_prompt(candidate_document, text_blocks)
        parts: list[Any] = [prompt]
        if overlay_png_path is not None:
            parts.append({"mime_type": "image/png", "data": Path(overlay_png_path).read_bytes()})

        response = model.generate_content(
            parts,
            generation_config={
                "response_mime_type": "application/json",
                "response_schema": VALIDATION_SCHEMA,
            },
        )
        payload = cast(dict[str, Any], json.loads(response.text))
        return _coerce_validation_result(
            payload=payload,
            candidate_document=candidate_document,
            provider=self.name,
            model_name=model_name,
        )


def _coerce_validation_result(
    *,
    payload: dict[str, Any],
    candidate_document: CandidateDocument,
    provider: str,
    model_name: str,
) -> SemanticValidationResult:
    candidates_by_id = {
        candidate.id: candidate for candidate in candidate_document.candidate_regions
    }
    selected_id = str(payload.get("selected_candidate_id", ""))
    candidate = candidates_by_id.get(selected_id)
    if candidate is None:
        candidate = next(
            (
                item
                for item in candidate_document.candidate_regions
                if item.eligible_for_auto_export
                and item.geometry_source != "coarse_semantic_search_area"
            ),
            candidate_document.candidate_regions[0],
        )
        return SemanticValidationResult(
            selected_candidate_id=candidate.id,
            reason=(
                "Gemini returned an unknown candidate id; selected the highest ranked "
                "available candidate and required review."
            ),
            confidence=min(0.55, candidate.score),
            review_required=True,
            provider=provider,
            model=model_name,
            escalation_used=False,
        )

    confidence = max(0.0, min(1.0, float(payload.get("confidence", 0.0))))
    review_required = bool(payload.get("review_required", True))
    if (
        candidate.geometry_source == "coarse_semantic_search_area"
        or not candidate.eligible_for_auto_export
    ):
        review_required = True
        confidence = min(confidence, 0.58)
    if candidate.review_required:
        review_required = True
    if candidate.quality_warnings:
        review_required = True

    return SemanticValidationResult(
            selected_candidate_id=str(payload["selected_candidate_id"]),
            reason=str(payload["reason"]),
            confidence=confidence,
            review_required=review_required,
            provider=provider,
            model=model_name,
            escalation_used=False,
        )


def _build_validation_prompt(
    candidate_document: CandidateDocument,
    text_blocks: list[TextBlock],
) -> str:
    candidate_payload = []
    for candidate in candidate_document.candidate_regions[:8]:
        candidate_payload.append(
            candidate.model_dump(
                mode="json",
                include={
                    "id",
                    "rank",
                    "bbox_pdf",
                    "area_pdf_units",
                    "geometry_source",
                    "geometry_confidence",
                    "eligible_for_auto_export",
                    "review_required",
                    "quality_warnings",
                    "features",
                    "scores",
                    "score",
                },
            )
        )
    text_payload = [
        block.model_dump(mode="json", by_alias=True)
        for block in text_blocks
        if block.text_class
        in {
            "drawing_title",
            "scale_text",
            "drawing_number",
            "revision",
            "rwp_label",
            "rooflight_label",
            "roof_build_up_note",
            "fall_path_note",
            "general_note",
        }
    ][:80]
    return (
        "Select the candidate that best represents the proposed flat roof / tapered "
        "insulation scope. Use the overlay image, candidate features, and text blocks. "
        "Do not invent coordinates; select only one provided candidate id. Prefer CAD-final "
        "linework-derived candidates over coarse semantic search areas. A candidate with "
        "geometry_source='coarse_semantic_search_area' is only a fallback search region; if "
        "you select it, review_required must be true and confidence must be below 0.60. "
        "If the best candidate has quality_warnings, review_required must be true. "
        "Return strict JSON.\n\n"
        f"Candidates:\n{json.dumps(candidate_payload)}\n\n"
        f"Text blocks:\n{json.dumps(text_payload)}"
    )
