from copy import deepcopy
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.candidates import (
    CandidateDocument,
    CandidateFeatures,
    CandidateRegion,
    CandidateScores,
    CandidateSummary,
)
from app.models.validation import SemanticValidationResult
from app.services.ai.gemini import VALIDATION_SCHEMA, GeminiProvider
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.overlays import _overlay_candidates, render_candidate_overlay
from app.services.storage.validation import load_validation_response
from app.services.vector_pipeline.extractor import extract_vector_document


def _validate_with_mock(pdf_path: Path) -> SemanticValidationResult:
    provider = MockProvider()
    vector_document = extract_vector_document(pdf_path, pdf_path.stem, provider)
    candidate_document = generate_candidate_document(vector_document)
    return provider.validate_candidates(
        candidate_document=candidate_document,
        text_blocks=vector_document.text_blocks,
        overlay_png_path=None,
    )


def test_mock_validation_matches_golden_for_all_sample_pdfs(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        result = _validate_with_mock(pdf_path)

        assert result.selected_candidate_id
        assert result.provider == "mock"
        assert result.model == "mock-deterministic-v1"
        assert result.review_required


def test_tp17221_mock_selects_roof_scope_candidate(tp17221_pdf: Path) -> None:
    result = _validate_with_mock(tp17221_pdf)

    assert result.selected_candidate_id != "candidate_coarse_semantic_search_01"
    assert result.selected_candidate_id.startswith("candidate_vector_")
    assert 0.45 <= result.confidence <= 0.75
    assert result.review_required
    assert "human review" in result.reason


def test_mock_validation_selects_review_visible_reconstruction(tp17221_pdf: Path) -> None:
    provider = MockProvider()
    vector_document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, provider)
    candidate_document = generate_candidate_document(vector_document)
    review_candidate = next(
        candidate
        for candidate in candidate_document.candidate_regions
        if candidate.geometry_source == "anchor_boundary_reconstruction"
    )

    result = provider.validate_candidates(
        candidate_document=candidate_document,
        text_blocks=vector_document.text_blocks,
        overlay_png_path=None,
    )

    assert review_candidate.safety_status == "review"
    assert "synthetic_gap_bridges_used" in review_candidate.quality_warnings
    assert result.selected_candidate_id == review_candidate.id
    assert result.selected_review_candidate_id == review_candidate.id
    assert result.selected_auto_export_candidate_id is None
    assert result.confidence <= 0.7


def test_candidate_overlay_is_rendered(tp17221_pdf: Path, tmp_path: Path) -> None:
    provider = MockProvider()
    vector_document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, provider)
    candidate_document = generate_candidate_document(vector_document)
    overlay_path = render_candidate_overlay(
        source_path=tp17221_pdf,
        candidate_document=candidate_document,
        output_path=tmp_path / "candidate_overlay.png",
    )

    assert overlay_path.exists()
    assert overlay_path.stat().st_size > 0


def test_candidate_overlay_includes_blocked_reconstruction_for_review(
    tp17221_pdf: Path,
) -> None:
    provider = MockProvider()
    vector_document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, provider)
    candidate_document = generate_candidate_document(vector_document)
    blocked = next(
        candidate
        for candidate in candidate_document.candidate_regions
        if candidate.geometry_source == "anchor_boundary_reconstruction"
    )
    overlay_candidates = _overlay_candidates(candidate_document, top_n=5)

    assert blocked.rank > 5
    assert blocked.safety_status == "review"
    assert not blocked.eligible_for_auto_export
    assert blocked.eligible_for_review_selection
    assert blocked in overlay_candidates


def test_validate_endpoint_returns_structured_response(
    tp17221_pdf: Path,
    tmp_path: Path,
) -> None:
    app = create_app(Settings(storage_root=tmp_path, ai_provider="mock"))

    with TestClient(app) as client, tp17221_pdf.open("rb") as upload:
        upload_response = client.post(
            "/api/documents",
            files={"file": (tp17221_pdf.name, upload, "application/pdf")},
        )
        document_id = upload_response.json()["document_id"]
        validation_response = client.post(f"/api/documents/{document_id}/validate")

    assert upload_response.status_code == 201
    assert validation_response.status_code == 200
    data = validation_response.json()
    assert data["document_id"] == document_id
    assert data["overlay_png_path"] == f"uploads/{document_id}/candidate_overlay.png"
    assert (tmp_path / data["overlay_png_path"]).exists()
    assert data["validation"]["selected_candidate_id"] != "candidate_coarse_semantic_search_01"
    assert data["validation"]["selected_review_candidate_id"] == data["validation"][
        "selected_candidate_id"
    ]
    assert data["validation"]["selected_auto_export_candidate_id"] is None
    assert data["validation"]["review_required"] is True
    assert data["validation"]["confidence"] <= 0.75
    saved = load_validation_response(storage_path=tmp_path, document_id=document_id)
    assert saved is not None
    assert saved.overlay_png_path == f"uploads/{document_id}/candidate_overlay.png"


def test_gemini_provider_uses_google_genai_json_adapter() -> None:
    calls: list[dict[str, object]] = []

    def fake_json_generator(**kwargs: object) -> dict[str, object]:
        calls.append(kwargs)
        return {
            "selected_candidate_id": "candidate_vector_01",
            "reason": "Best supported roof-scope candidate.",
            "confidence": 0.86,
            "review_required": False,
        }

    provider = GeminiProvider(api_key="test-key", json_generator=fake_json_generator)
    result = provider.validate_candidates(
        candidate_document=_minimal_candidate_document(),
        text_blocks=[],
        overlay_png_path="overlay.png",
    )

    assert result.provider == "gemini"
    assert result.model == "gemini-3-flash-preview"
    assert result.selected_candidate_id == "candidate_vector_01"
    assert result.selected_review_candidate_id == "candidate_vector_01"
    assert result.selected_auto_export_candidate_id == "candidate_vector_01"
    assert result.confidence == 0.86
    assert result.review_required is False
    assert calls[0]["api_key"] == "test-key"
    assert calls[0]["model_name"] == "gemini-3-flash-preview"
    assert calls[0]["image_path"] == "overlay.png"


def test_gemini_validation_schema_is_sdk_compatible() -> None:
    from google.genai import _transformers, types

    schema = _transformers.t_schema(None, deepcopy(VALIDATION_SCHEMA))

    assert schema is not None
    assert schema.properties is not None
    auto_export_property = schema.properties["selected_auto_export_candidate_id"]
    assert auto_export_property.type == types.Type.STRING
    assert auto_export_property.nullable is True


def _minimal_candidate_document() -> CandidateDocument:
    features = CandidateFeatures(
        contains_rooflights=True,
        rooflight_count=2,
        contains_rwp_labels=True,
        rwp_label_count=3,
        near_tapered_insulation_note=True,
        near_fall_arrows=True,
        overlaps_title_block=False,
        overlaps_pv_array=False,
        geometry_valid=True,
        plausible_area=True,
    )
    scores = CandidateScores(
        geometric_validity=0.9,
        agreement_with_vector_linework=0.9,
        contains_expected_rooflights=0.8,
        contains_expected_rwp_points=0.8,
        proximity_to_tapered_insulation_notes=0.75,
        excludes_title_block_legend_pv=0.95,
        plausible_area_and_dimensions=0.85,
    )
    candidate = CandidateRegion(
        id="candidate_vector_01",
        rank=1,
        polygon_pdf=[[0, 0], [100, 0], [100, 100], [0, 100]],
        bbox_pdf=[0, 0, 100, 100],
        area_pdf_units=10_000,
        geometry_source="vector_polygonized_face",
        geometry_confidence=0.9,
        eligible_for_auto_export=True,
        review_required=False,
        safety_status="pass",
        features=features,
        scores=scores,
        score=0.88,
    )
    return CandidateDocument(
        document_id="doc",
        source_file="sample.pdf",
        pipeline_profile="vector",
        candidate_regions=[candidate],
        summary=CandidateSummary(
            candidate_count=1,
            top_candidate_id="candidate_vector_01",
            top_candidate_score=0.88,
            roof_scope_candidate_rank=1,
        ),
    )
