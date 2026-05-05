import json
from pathlib import Path
from typing import Any

import pytest

from app.models.candidates import (
    CandidateDocument,
    CandidateFeatures,
    CandidateRegion,
    CandidateScores,
    CandidateSummary,
)
from app.models.vector import TextBlock
from app.services.ai import gemini
from app.services.ai.gemini import GeminiProvider


def _install_fake_genai_client(
    monkeypatch: pytest.MonkeyPatch,
    payload: dict[str, Any],
) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []

    class FakeResponse:
        text = json.dumps(payload)

    class FakeModels:
        def generate_content(self, *, model: str, contents: Any, config: Any) -> FakeResponse:
            calls.append({"model": model, "contents": contents, "config": config})
            return FakeResponse()

    class FakeClient:
        models = FakeModels()

        def __enter__(self) -> "FakeClient":
            return self

        def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
            return None

    def fake_client(api_key: str) -> FakeClient:
        calls.append({"api_key": api_key})
        return FakeClient()

    def fake_config(response_schema: dict[str, Any]) -> dict[str, Any]:
        return {
            "response_mime_type": "application/json",
            "response_json_schema": response_schema,
        }

    def fake_image_part(path: str) -> dict[str, str]:
        return {"image_path": Path(path).name}

    monkeypatch.setattr(gemini, "_create_genai_client", fake_client)
    monkeypatch.setattr(gemini, "_json_response_config", fake_config)
    monkeypatch.setattr(gemini, "_image_part_from_path", fake_image_part)
    return calls


def _candidate_document() -> CandidateDocument:
    candidate = CandidateRegion(
        id="candidate_vector_01",
        rank=1,
        polygon_pdf=[[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
        bbox_pdf=[0.0, 0.0, 10.0, 10.0],
        area_pdf_units=100.0,
        geometry_source="vector_polygonized_face",
        geometry_confidence=0.95,
        eligible_for_auto_export=True,
        review_required=False,
        quality_warnings=[],
        features=CandidateFeatures(
            contains_rooflights=False,
            rooflight_count=0,
            contains_rwp_labels=True,
            rwp_label_count=2,
            near_tapered_insulation_note=True,
            near_fall_arrows=True,
            overlaps_title_block=False,
            overlaps_pv_array=False,
            geometry_valid=True,
            plausible_area=True,
        ),
        scores=CandidateScores(
            geometric_validity=1.0,
            agreement_with_vector_linework=0.9,
            contains_expected_rooflights=0.5,
            contains_expected_rwp_points=0.8,
            proximity_to_tapered_insulation_notes=0.9,
            excludes_title_block_legend_pv=1.0,
            plausible_area_and_dimensions=1.0,
            boundary_evidence_quality=0.9,
            semantic_scope_alignment=0.9,
            excludes_detected_exclusions=1.0,
        ),
        score=0.91,
    )
    return CandidateDocument(
        document_id="document_01",
        source_file="drawing.pdf",
        pipeline_profile="vector",
        candidate_regions=[candidate],
        summary=CandidateSummary(
            candidate_count=1,
            top_candidate_id="candidate_vector_01",
            top_candidate_score=0.91,
            roof_scope_candidate_rank=1,
        ),
    )


def _candidate_document_with_coarse_candidate() -> CandidateDocument:
    document = _candidate_document()
    vector_candidate = document.candidate_regions[0]
    coarse_candidate = vector_candidate.model_copy(
        update={
            "id": "candidate_coarse_semantic_search_01",
            "rank": 2,
            "geometry_source": "coarse_semantic_search_area",
            "geometry_confidence": 0.35,
            "eligible_for_auto_export": False,
            "review_required": True,
            "quality_warnings": [
                "coarse_semantic_search_area",
                "not_cad_final_geometry",
            ],
            "score": 0.2,
        }
    )
    return CandidateDocument(
        document_id=document.document_id,
        source_file=document.source_file,
        pipeline_profile=document.pipeline_profile,
        candidate_regions=[vector_candidate, coarse_candidate],
        summary=CandidateSummary(
            candidate_count=2,
            top_candidate_id="candidate_vector_01",
            top_candidate_score=0.91,
            roof_scope_candidate_rank=1,
        ),
    )


def _candidate_document_with_unsafe_opencv_candidate() -> CandidateDocument:
    document = _candidate_document()
    vector_candidate = document.candidate_regions[0].model_copy(update={"rank": 2})
    unsafe_candidate = vector_candidate.model_copy(
        update={
            "id": "candidate_opencv_refined_semantic_01",
            "rank": 1,
            "geometry_source": "opencv_refined_vector_candidate",
            "eligible_for_auto_export": False,
            "review_required": True,
            "quality_warnings": [
                "candidate_area_too_broad",
                "candidate_overunion_risk",
                "opencv_boundary_support_low",
                "opencv_refined_from_coarse_candidate",
            ],
            "source_candidate_id": "candidate_coarse_semantic_search_01",
            "source_geometry_source": "coarse_semantic_search_area",
            "score": 0.8,
        }
    )
    return CandidateDocument(
        document_id=document.document_id,
        source_file=document.source_file,
        pipeline_profile=document.pipeline_profile,
        candidate_regions=[unsafe_candidate, vector_candidate],
        summary=CandidateSummary(
            candidate_count=2,
            top_candidate_id="candidate_opencv_refined_semantic_01",
            top_candidate_score=0.8,
            roof_scope_candidate_rank=2,
        ),
    )


def test_gemini_text_classification_uses_google_genai_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls = _install_fake_genai_client(
        monkeypatch,
        {
            "classifications": [
                {
                    "id": "text_01",
                    "class": "tapered_scope_note",
                    "semantic_confidence": 0.92,
                }
            ]
        },
    )
    provider = GeminiProvider(api_key="test-key", flash_model="gemini-test-flash")

    results = provider.classify_text_blocks(
        [
            TextBlock(
                id="text_01",
                page_number=1,
                text="TAPERED INSULATION TO FALLS",
                bbox_pdf=[0.0, 0.0, 10.0, 10.0],
            )
        ]
    )

    assert results[0].text_class == "tapered_scope_note"
    assert results[0].semantic_confidence == 0.92
    assert results[0].class_source == "gemini-test-flash"
    assert calls[0] == {"api_key": "test-key"}
    assert calls[1]["model"] == "gemini-test-flash"
    assert isinstance(calls[1]["contents"], str)
    assert calls[1]["config"]["response_json_schema"] == gemini.TEXT_CLASSIFICATION_SCHEMA


def test_gemini_text_classification_preserves_geometry_critical_mock_classes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_genai_client(
        monkeypatch,
        {
            "classifications": [
                {
                    "id": "rwp_01",
                    "class": "general_note",
                    "semantic_confidence": 0.99,
                },
                {
                    "id": "note_01",
                    "class": "drainage_note",
                    "semantic_confidence": 0.91,
                },
            ]
        },
    )
    provider = GeminiProvider(api_key="test-key", flash_model="gemini-test-flash")

    results = provider.classify_text_blocks(
        [
            TextBlock(
                id="rwp_01",
                page_number=1,
                text="RWP.1",
                bbox_pdf=[0.0, 0.0, 10.0, 10.0],
            ),
            TextBlock(
                id="note_01",
                page_number=1,
                text="This annotation is intentionally ambiguous and long enough for review.",
                bbox_pdf=[20.0, 0.0, 100.0, 10.0],
            ),
        ]
    )

    assert results[0].text_class == "rwp_label"
    assert results[0].class_source == "mock"
    assert results[1].text_class == "drainage_note"
    assert results[1].class_source == "gemini-test-flash"


def test_gemini_text_classification_preserves_fall_gradient_over_scale(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _install_fake_genai_client(
        monkeypatch,
        {
            "classifications": [
                {
                    "id": "gradient_01",
                    "class": "scale_text",
                    "semantic_confidence": 0.97,
                }
            ]
        },
    )
    provider = GeminiProvider(api_key="test-key", flash_model="gemini-test-flash")

    results = provider.classify_text_blocks(
        [
            TextBlock(
                id="gradient_01",
                page_number=1,
                text="Designed gradient of 1:40 to ensure a finished fall of 1:80",
                bbox_pdf=[0.0, 0.0, 120.0, 20.0],
            )
        ]
    )

    assert results[0].text_class == "fall_path_note"
    assert results[0].class_source == "mock"


def test_gemini_validation_uses_new_client_with_overlay_part(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls = _install_fake_genai_client(
        monkeypatch,
        {
            "selected_candidate_id": "candidate_vector_01",
            "reason": "Best supported CAD boundary with tapered-scope evidence.",
            "confidence": 0.88,
            "review_required": False,
        },
    )
    overlay_path = tmp_path / "overlay.png"
    overlay_path.write_bytes(b"png-bytes")
    provider = GeminiProvider(api_key="test-key", flash_model="gemini-test-flash")

    result = provider.validate_candidates(
        candidate_document=_candidate_document(),
        text_blocks=[],
        overlay_png_path=str(overlay_path),
    )

    assert result.selected_candidate_id == "candidate_vector_01"
    assert result.provider == "gemini"
    assert result.model == "gemini-test-flash"
    assert result.confidence == 0.88
    assert result.review_required is False
    assert calls[1]["model"] == "gemini-test-flash"
    assert calls[1]["contents"][1] == {"image_path": "overlay.png"}
    assert calls[1]["config"]["response_json_schema"] == gemini.VALIDATION_SCHEMA


def test_gemini_validation_demotes_coarse_candidate_selection(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _install_fake_genai_client(
        monkeypatch,
        {
            "selected_candidate_id": "candidate_coarse_semantic_search_01",
            "reason": "The broad region contains all semantic roof evidence.",
            "confidence": 0.9,
            "review_required": False,
        },
    )
    overlay_path = tmp_path / "overlay.png"
    overlay_path.write_bytes(b"png-bytes")
    provider = GeminiProvider(api_key="test-key", flash_model="gemini-test-flash")

    result = provider.validate_candidates(
        candidate_document=_candidate_document_with_coarse_candidate(),
        text_blocks=[],
        overlay_png_path=str(overlay_path),
    )

    assert result.selected_candidate_id == "candidate_vector_01"
    assert result.review_required is True
    assert result.confidence <= 0.62
    assert "selection-blocked candidate" in result.reason


def test_gemini_validation_demotes_unsafe_opencv_candidate_selection(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _install_fake_genai_client(
        monkeypatch,
        {
            "selected_candidate_id": "candidate_opencv_refined_semantic_01",
            "reason": "The broad OpenCV candidate contains all visible scope evidence.",
            "confidence": 0.92,
            "review_required": False,
        },
    )
    overlay_path = tmp_path / "overlay.png"
    overlay_path.write_bytes(b"png-bytes")
    provider = GeminiProvider(api_key="test-key", flash_model="gemini-test-flash")

    result = provider.validate_candidates(
        candidate_document=_candidate_document_with_unsafe_opencv_candidate(),
        text_blocks=[],
        overlay_png_path=str(overlay_path),
    )

    assert result.selected_candidate_id == "candidate_vector_01"
    assert result.review_required is True
    assert result.confidence <= 0.62
    assert "selection-blocked candidate" in result.reason
