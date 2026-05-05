from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.candidates import CandidateDocument
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.vector_pipeline.extractor import extract_vector_document


def _generate_candidates(pdf_path: Path) -> CandidateDocument:
    vector_document = extract_vector_document(pdf_path, pdf_path.stem, MockProvider())
    return generate_candidate_document(vector_document)


def test_candidate_generation_matches_golden_summaries_for_all_sample_pdfs(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        actual = _generate_candidates(pdf_path)

        assert actual.summary.candidate_count == len(actual.candidate_regions)
        assert actual.candidate_regions == sorted(
            actual.candidate_regions,
            key=lambda candidate: candidate.score,
            reverse=True,
        )
        assert actual.summary.top_candidate_id == actual.candidate_regions[0].id
        for candidate in actual.candidate_regions:
            if candidate.geometry_source == "coarse_semantic_search_area":
                assert not candidate.eligible_for_auto_export
                assert candidate.review_required
                assert "not_cad_final_geometry" in candidate.quality_warnings


def test_tp17221_coarse_semantic_area_is_fallback_only(tp17221_pdf: Path) -> None:
    candidates = _generate_candidates(tp17221_pdf)
    reconstructed_candidate = next(
        candidate
        for candidate in candidates.candidate_regions
        if candidate.geometry_source == "anchor_boundary_reconstruction"
    )
    coarse_candidate = next(
        candidate
        for candidate in candidates.candidate_regions
        if candidate.geometry_source == "coarse_semantic_search_area"
    )

    assert candidates.candidate_regions[0] == reconstructed_candidate
    assert reconstructed_candidate.features.rwp_label_count == 5
    assert reconstructed_candidate.area_pdf_units > (
        10 * candidates.candidate_regions[1].area_pdf_units
    )
    assert "anchor_boundary_reconstruction_requires_review" in (
        reconstructed_candidate.quality_warnings
    )
    assert candidates.candidate_regions[0].geometry_source != "coarse_semantic_search_area"
    assert candidates.candidate_regions[0].eligible_for_auto_export
    assert candidates.candidate_regions[0].review_required
    assert coarse_candidate.rank > candidates.candidate_regions[0].rank
    assert coarse_candidate.features.contains_rooflights
    assert coarse_candidate.features.rwp_label_count == 5
    assert coarse_candidate.score < candidates.candidate_regions[0].score

    for candidate in candidates.candidate_regions:
        if candidate.features.overlaps_title_block or candidate.features.overlaps_pv_array:
            assert candidate.rank > candidates.candidate_regions[0].rank


def test_candidates_endpoint_returns_ranked_candidates(
    tp17221_pdf: Path,
    tmp_path: Path,
) -> None:
    app = create_app(Settings(storage_root=tmp_path))

    with TestClient(app) as client, tp17221_pdf.open("rb") as upload:
        upload_response = client.post(
            "/api/documents",
            files={"file": (tp17221_pdf.name, upload, "application/pdf")},
        )
        document_id = upload_response.json()["document_id"]
        candidates_response = client.get(f"/api/documents/{document_id}/candidates")

    assert upload_response.status_code == 201
    assert candidates_response.status_code == 200
    data = candidates_response.json()
    assert data["document_id"] == document_id
    assert data["summary"]["top_candidate_id"] != "candidate_coarse_semantic_search_01"
    assert data["summary"]["roof_scope_candidate_rank"] == 1
    assert data["candidate_regions"][0]["eligible_for_auto_export"] is True
    assert data["candidate_regions"][-1]["geometry_source"] == "coarse_semantic_search_area"
