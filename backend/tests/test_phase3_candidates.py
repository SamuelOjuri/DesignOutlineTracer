import json
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.models.candidates import CandidateDocument
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.vector_pipeline.extractor import extract_vector_document


def _golden_path(pdf_path: Path) -> Path:
    return Path(__file__).parent / "fixtures" / "golden" / pdf_path.stem / "phase3.json"


def _phase3_golden(pdf_path: Path) -> dict[str, object]:
    return cast(dict[str, object], json.loads(_golden_path(pdf_path).read_text(encoding="utf-8")))


def _generate_candidates(pdf_path: Path) -> CandidateDocument:
    vector_document = extract_vector_document(pdf_path, pdf_path.stem, MockProvider())
    return generate_candidate_document(vector_document)


def test_candidate_generation_matches_golden_summaries_for_all_sample_pdfs(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        expected = _phase3_golden(pdf_path)
        actual = _generate_candidates(pdf_path)

        assert actual.summary.model_dump(mode="json") == expected["summary"]
        assert [
            {
                "id": candidate.id,
                "rank": candidate.rank,
                "geometry_source": candidate.geometry_source,
                "score": candidate.score,
                "area_pdf_units": candidate.area_pdf_units,
                "features": candidate.features.model_dump(mode="json"),
            }
            for candidate in actual.candidate_regions[:5]
        ] == expected["top_candidates"]


def test_tp17221_roof_scope_candidate_is_top_three(tp17221_pdf: Path) -> None:
    candidates = _generate_candidates(tp17221_pdf)
    top_three = candidates.candidate_regions[:3]
    roof_scope = next(
        candidate
        for candidate in candidates.candidate_regions
        if candidate.geometry_source == "semantic_roof_scope_envelope"
    )

    assert roof_scope in top_three
    assert roof_scope.features.contains_rooflights
    assert roof_scope.features.rooflight_count >= 5
    assert roof_scope.features.contains_rwp_labels
    assert roof_scope.features.rwp_label_count == 5
    assert roof_scope.features.near_tapered_insulation_note
    assert not roof_scope.features.overlaps_title_block

    for candidate in candidates.candidate_regions:
        if candidate.features.overlaps_title_block or candidate.features.overlaps_pv_array:
            assert candidate.rank > roof_scope.rank


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
    assert data["summary"]["top_candidate_id"] == "candidate_semantic_roof_scope_01"
    assert data["summary"]["roof_scope_candidate_rank"] == 1
    assert data["candidate_regions"][0]["features"]["rwp_label_count"] == 5
