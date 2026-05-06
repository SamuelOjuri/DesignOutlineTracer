import json
from collections.abc import Callable
from typing import Any

from app.models.candidates import CandidateDocument, CandidateRegion
from app.models.validation import SemanticValidationResult
from app.models.vector import ClassifiedTextBlock, TextBlock
from app.services.ai.google_genai import generate_gemini_json
from app.services.ai.mock import MockProvider
from app.services.ai.provider import AiProvider
from app.services.geometry.safety import cap_confidence_for_safety, select_candidate_for_validation

VALIDATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "selected_candidate_id": {"type": "string"},
        "selected_review_candidate_id": {"type": "string"},
        "selected_auto_export_candidate_id": {"type": "string", "nullable": True},
        "reason": {"type": "string"},
        "confidence": {"type": "number"},
        "review_required": {"type": "boolean"},
    },
    "required": ["selected_candidate_id", "reason", "confidence", "review_required"],
}

JsonGenerator = Callable[..., dict[str, Any]]


class GeminiProvider(AiProvider):
    def __init__(
        self,
        *,
        api_key: str,
        flash_model: str = "gemini-2.5-flash",
        pro_model: str = "gemini-2.5-pro",
        allow_pro_escalation: bool = False,
        pro_escalation_confidence_threshold: float = 0.75,
        json_generator: JsonGenerator | None = None,
    ) -> None:
        self.api_key = api_key
        self.flash_model = flash_model
        self.pro_model = pro_model
        self.allow_pro_escalation = allow_pro_escalation
        self.pro_escalation_confidence_threshold = pro_escalation_confidence_threshold
        self._json_generator = json_generator or generate_gemini_json
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
        prompt = _build_validation_prompt(candidate_document, text_blocks)
        payload = self._json_generator(
            api_key=self.api_key,
            model_name=model_name,
            prompt=prompt,
            response_schema=VALIDATION_SCHEMA,
            image_path=overlay_png_path,
        )
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
    selected_id = str(
        payload.get("selected_review_candidate_id")
        or payload.get("selected_candidate_id", "")
    )
    candidate = candidates_by_id.get(selected_id)
    if candidate is None:
        selection = select_candidate_for_validation(candidate_document, selected_id)
        candidate = selection.candidate
        return SemanticValidationResult(
            selected_candidate_id=candidate.id,
            selected_review_candidate_id=candidate.id,
            selected_auto_export_candidate_id=None,
            reason=(
                "Gemini returned an unknown candidate id; selected the highest ranked "
                "available review candidate and required review."
            ),
            confidence=cap_confidence_for_safety(
                min(0.55, candidate.score),
                candidate=candidate,
                demoted=True,
            ),
            review_required=True,
            provider=provider,
            model=model_name,
            escalation_used=False,
        )

    selection = select_candidate_for_validation(candidate_document, selected_id)
    candidate = selection.candidate

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
    if candidate.safety_status != "pass" or selection.demoted:
        review_required = True
    confidence = cap_confidence_for_safety(
        confidence,
        candidate=candidate,
        demoted=selection.demoted,
    )
    reason = str(payload["reason"])
    if selection.demoted:
        reason = (
            f"{reason} Safety gate demoted {selected_id} to {candidate.id}: "
            f"{', '.join(selection.warnings)}."
        )
    elif candidate.safety_warnings:
        reason = f"{reason} Safety gate warnings: {', '.join(candidate.safety_warnings)}."

    return SemanticValidationResult(
        selected_candidate_id=candidate.id,
        selected_review_candidate_id=candidate.id,
        selected_auto_export_candidate_id=_selected_auto_export_candidate_id(
            candidate=candidate,
            review_required=review_required,
        ),
        reason=reason,
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
                    "eligible_for_review_selection",
                    "eligible_for_final_dxf",
                    "review_required",
                    "quality_warnings",
                    "safety_status",
                    "safety_warnings",
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
        "Do not invent coordinates; select only one provided candidate id as "
        "selected_review_candidate_id and mirror it in selected_candidate_id for backward "
        "compatibility. Prefer the candidate that best covers the proposed flat roof / tapered "
        "insulation scope for human review, even when it is not eligible for automatic export. "
        "Set selected_auto_export_candidate_id only when that same candidate is confidently "
        "eligible for automatic final export; otherwise return null. A candidate with "
        "geometry_source='coarse_semantic_search_area' is only a fallback search region; if "
        "you select it, review_required must be true and confidence must be below 0.60. "
        "Candidates with eligible_for_review_selection=true may be selected for review even "
        "when eligible_for_auto_export=false or safety_status='review'. Treat "
        "safety_status='blocked' as a hard constraint only for review selection. If the best "
        "review candidate has quality_warnings, review_required must be true. "
        "Return strict JSON.\n\n"
        f"Candidates:\n{json.dumps(candidate_payload)}\n\n"
        f"Text blocks:\n{json.dumps(text_payload)}"
    )


def _selected_auto_export_candidate_id(
    *,
    candidate: CandidateRegion,
    review_required: bool,
) -> str | None:
    if review_required:
        return None
    if not candidate.eligible_for_auto_export:
        return None
    if not candidate.eligible_for_final_dxf:
        return None
    if candidate.safety_status != "pass":
        return None
    return candidate.id
