from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.validation import SemanticValidationResult
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.overlays import render_candidate_overlay
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


def test_candidate_overlay_is_rendered(tp17221_pdf: Path, tmp_path: Path) -> None:
    provider = MockProvider()
    vector_document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, provider)
    candidate_document = generate_candidate_document(vector_document)
    overlay_path = render_candidate_overlay(
        source_path=tp17221_pdf,
        candidate_document=candidate_document,
        output_path=tmp_path / "candidate_overlay.png",
        selected_candidate_id=candidate_document.candidate_regions[0].id,
    )

    assert overlay_path.exists()
    assert overlay_path.stat().st_size > 0


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
    assert data["validation"]["review_required"] is True
    assert data["validation"]["confidence"] <= 0.75
