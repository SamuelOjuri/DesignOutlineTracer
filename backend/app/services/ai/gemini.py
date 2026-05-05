import json
from pathlib import Path
from typing import Any, cast, get_args

from app.models.candidates import CandidateDocument, CandidateRegion
from app.models.validation import SemanticValidationResult
from app.models.vector import ClassifiedTextBlock, TextBlock, TextBlockClass
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

TEXT_CLASSIFICATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "classifications": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": {"type": "string"},
                    "class": {"type": "string", "enum": list(get_args(TextBlockClass))},
                    "semantic_confidence": {"type": "number"},
                },
                "required": ["id", "class", "semantic_confidence"],
            },
        }
    },
    "required": ["classifications"],
}

GEOMETRY_CRITICAL_TEXT_CLASSES: set[str] = {
    "rwp_label",
    "scale_text",
    "drawing_number",
    "revision",
    "pv_note",
    "existing_roof_note",
    "pitched_roof_note",
    "rooflight_label",
    "rooflight_spec",
    "roof_build_up_note",
    "tapered_scope_note",
    "flat_roof_note",
    "fall_path_note",
    "drainage_note",
}


class GeminiProvider(AiProvider):
    def __init__(
        self,
        *,
        api_key: str,
        flash_model: str = "gemini-3-flash-preview",
        pro_model: str = "gemini-3.1-pro-preview",
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
        if not text_blocks:
            return []
        deterministic = self._mock_text_classifier.classify_text_blocks(text_blocks)
        try:
            gemini = self._run_text_classification_model(text_blocks, fallback=deterministic)
            return _merge_text_classifications(
                text_blocks=text_blocks,
                deterministic=deterministic,
                gemini=gemini,
            )
        except Exception:
            return deterministic

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
        parts: list[Any] = [prompt]
        if overlay_png_path is not None:
            parts.append(_image_part_from_path(overlay_png_path))

        with _create_genai_client(self.api_key) as client:
            response = client.models.generate_content(
                model=model_name,
                contents=parts,
                config=_json_response_config(VALIDATION_SCHEMA),
            )
        payload = _json_response_payload(response)
        return _coerce_validation_result(
            payload=payload,
            candidate_document=candidate_document,
            provider=self.name,
            model_name=model_name,
        )

    def _run_text_classification_model(
        self,
        text_blocks: list[TextBlock],
        fallback: list[ClassifiedTextBlock],
    ) -> list[ClassifiedTextBlock]:
        prompt = _build_text_classification_prompt(text_blocks)
        with _create_genai_client(self.api_key) as client:
            response = client.models.generate_content(
                model=self.flash_model,
                contents=prompt,
                config=_json_response_config(TEXT_CLASSIFICATION_SCHEMA),
            )
        payload = _json_response_payload(response)
        return _coerce_text_classifications(
            payload=payload,
            text_blocks=text_blocks,
            fallback=fallback,
            model_name=self.flash_model,
        )


def _create_genai_client(api_key: str) -> Any:
    from google import genai

    return genai.Client(api_key=api_key)


def _json_response_config(response_schema: dict[str, Any]) -> Any:
    from google.genai import types

    return types.GenerateContentConfig(
        response_mime_type="application/json",
        response_json_schema=response_schema,
    )


def _image_part_from_path(path: str) -> Any:
    from google.genai import types

    return types.Part.from_bytes(data=Path(path).read_bytes(), mime_type="image/png")


def _json_response_payload(response: Any) -> dict[str, Any]:
    parsed = getattr(response, "parsed", None)
    if isinstance(parsed, dict):
        return cast(dict[str, Any], parsed)

    response_text = getattr(response, "text", "")
    if not isinstance(response_text, str) or not response_text.strip():
        raise ValueError("Gemini returned an empty JSON response")
    return cast(dict[str, Any], json.loads(response_text))


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
    if _candidate_requires_demotion(candidate):
        review_required = True
        confidence = min(confidence, 0.58)
        replacement = _best_selectable_candidate(candidate_document, selected=candidate)
        if replacement is not None:
            return SemanticValidationResult(
                selected_candidate_id=replacement.id,
                reason=(
                    "Gemini selected a coarse, coarse-derived, or selection-blocked candidate. "
                    "The backend selected the highest-ranked safe non-coarse candidate instead. "
                    "Human review is required."
                ),
                confidence=max(0.35, min(confidence, replacement.score, 0.62)),
                review_required=True,
                provider=provider,
                model=model_name,
                escalation_used=False,
            )
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


SELECTION_BLOCKING_QUALITY_WARNINGS = {
    "candidate_area_too_broad",
    "candidate_overunion_risk",
    "low_boundary_linework_agreement",
    "opencv_boundary_support_low",
    "opencv_refined_from_coarse_candidate",
}


def _candidate_requires_demotion(candidate: CandidateRegion) -> bool:
    return (
        candidate.geometry_source == "coarse_semantic_search_area"
        or not candidate.eligible_for_auto_export
        or bool(SELECTION_BLOCKING_QUALITY_WARNINGS.intersection(candidate.quality_warnings))
    )


def _best_selectable_candidate(
    candidate_document: CandidateDocument,
    *,
    selected: CandidateRegion,
) -> CandidateRegion | None:
    return next(
        (
            candidate
            for candidate in candidate_document.candidate_regions
            if candidate.id != selected.id
            and candidate.geometry_source != "coarse_semantic_search_area"
            and candidate.eligible_for_auto_export
            and not SELECTION_BLOCKING_QUALITY_WARNINGS.intersection(candidate.quality_warnings)
        ),
        None,
    )


def _merge_text_classifications(
    *,
    text_blocks: list[TextBlock],
    deterministic: list[ClassifiedTextBlock],
    gemini: list[ClassifiedTextBlock],
) -> list[ClassifiedTextBlock]:
    gemini_by_id = {block.id: block for block in gemini}
    text_by_id = {block.id: block.text for block in text_blocks}
    merged: list[ClassifiedTextBlock] = []
    for deterministic_block in deterministic:
        gemini_block = gemini_by_id.get(deterministic_block.id)
        if gemini_block is None:
            merged.append(deterministic_block)
            continue
        if _should_preserve_deterministic_class(
            deterministic_block,
            gemini_block,
            original_text=text_by_id.get(deterministic_block.id, ""),
        ):
            merged.append(deterministic_block)
            continue
        merged.append(gemini_block)
    return merged


def _should_preserve_deterministic_class(
    deterministic: ClassifiedTextBlock,
    gemini: ClassifiedTextBlock,
    *,
    original_text: str,
) -> bool:
    if deterministic.text_class == "scale_text" and _contains_fall_or_drainage_language(
        original_text
    ):
        return False
    if deterministic.text_class not in GEOMETRY_CRITICAL_TEXT_CLASSES:
        return False
    if deterministic.text_class == gemini.text_class:
        return False
    return deterministic.semantic_confidence >= 0.75


def _contains_fall_or_drainage_language(text: str) -> bool:
    normalized = text.lower()
    return any(
        token in normalized
        for token in ("fall", "gradient", "hopper", "downpipe", "drainage", "rainwater")
    )


def _build_text_classification_prompt(text_blocks: list[TextBlock]) -> str:
    text_payload = [
        block.model_dump(mode="json", include={"id", "text", "bbox_pdf", "page_number"})
        for block in text_blocks[:120]
    ]
    classes = list(get_args(TextBlockClass))
    return (
        "Classify architectural roof-plan PDF text blocks for tapered-insulation scope "
        "extraction. Use only the provided class enum. Prefer specific production evidence "
        "classes over general_note where possible: rwp labels, rooflights, tapered scope, "
        "flat roof/single-ply notes, drainage/fall notes, PV/existing/pitched/exclusion notes, "
        "title block metadata, and zone labels. Return strict JSON with one classification for "
        "each supplied id.\n\n"
        f"Allowed classes:\n{json.dumps(classes)}\n\n"
        f"Text blocks:\n{json.dumps(text_payload)}"
    )


def _coerce_text_classifications(
    *,
    payload: dict[str, Any],
    text_blocks: list[TextBlock],
    fallback: list[ClassifiedTextBlock],
    model_name: str,
) -> list[ClassifiedTextBlock]:
    allowed_classes = set(get_args(TextBlockClass))
    fallback_by_id = {block.id: block for block in fallback}
    returned_by_id: dict[str, dict[str, Any]] = {}
    for item in payload.get("classifications", []):
        if not isinstance(item, dict):
            continue
        block_id = str(item.get("id", ""))
        if block_id:
            returned_by_id[block_id] = item

    results: list[ClassifiedTextBlock] = []
    for block in text_blocks:
        item = returned_by_id.get(block.id)
        fallback_block = fallback_by_id[block.id]
        if item is None or item.get("class") not in allowed_classes:
            results.append(fallback_block)
            continue
        confidence = max(0.0, min(1.0, float(item.get("semantic_confidence", 0.0))))
        if confidence < 0.35:
            results.append(fallback_block)
            continue
        results.append(
            ClassifiedTextBlock(
                id=block.id,
                text_class=cast(TextBlockClass, item["class"]),
                semantic_confidence=round(confidence, 4),
                class_source=model_name,
            )
        )
    return results


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
                    "boundary_metrics",
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
            "rooflight_spec",
            "roof_build_up_note",
            "tapered_scope_note",
            "flat_roof_note",
            "fall_path_note",
            "drainage_note",
            "pv_note",
            "existing_roof_note",
            "pitched_roof_note",
            "exclusion_note",
            "phase_or_zone_label",
            "general_note",
        }
    ][:80]
    zone_payload = [zone.model_dump(mode="json") for zone in candidate_document.semantic_zones[:40]]
    return (
        "Select the candidate that best represents the proposed flat roof / tapered "
        "insulation scope. Use the overlay image, candidate features, and text blocks. "
        "Do not invent coordinates; select only one provided candidate id. Prefer CAD-final "
        "linework-derived candidates over coarse semantic search areas. Prefer candidates with "
        "strong boundary_metrics.linework_closure_confidence, high included positive anchors, "
        "low synthetic/search-boundary reliance, and low overlap with semantic exclusion zones. "
        "A candidate with "
        "geometry_source='coarse_semantic_search_area' is only a fallback search region; if "
        "you select it, review_required must be true and confidence must be below 0.60. "
        "If the best candidate has quality_warnings, review_required must be true. "
        "Return strict JSON.\n\n"
        f"Target scope intent:\n{candidate_document.target_scope_intent.model_dump_json()}\n\n"
        f"Semantic zones:\n{json.dumps(zone_payload)}\n\n"
        f"Candidates:\n{json.dumps(candidate_payload)}\n\n"
        f"Text blocks:\n{json.dumps(text_payload)}"
    )
