import json
from pathlib import Path
from typing import cast

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.ai.mock import MockProvider
from app.services.vector_pipeline.extractor import extract_vector_document


def _golden_path(pdf_path: Path) -> Path:
    return Path(__file__).parent / "fixtures" / "golden" / pdf_path.stem / "phase2.json"


def _phase2_golden(pdf_path: Path) -> dict[str, object]:
    return cast(dict[str, object], json.loads(_golden_path(pdf_path).read_text(encoding="utf-8")))


def test_vector_extraction_matches_golden_counts_for_all_sample_pdfs(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        expected = _phase2_golden(pdf_path)
        actual = extract_vector_document(pdf_path, pdf_path.stem, MockProvider())

        assert actual.summary.model_dump(mode="json") == expected["summary"]
        assert actual.page_metadata[0].model_dump(mode="json") == expected["page_metadata"]
        assert [region.model_dump(mode="json") for region in actual.sheet_regions] == expected[
            "sheet_regions"
        ]


def test_tp17221_extracts_required_vector_signals(tp17221_pdf: Path) -> None:
    document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, MockProvider())
    all_text = "\n".join(block.text for block in document.text_blocks)
    title_block = next(region for region in document.sheet_regions if region.type == "title_block")
    viewport = next(
        region for region in document.sheet_regions if region.type == "drawing_viewport"
    )

    assert "Roof Plan" in all_text or "ROOF PLAN" in all_text
    assert "1:50" in all_text
    assert "823-UA-CD-02-DR-A-102" in all_text
    assert "P2" in all_text
    assert "Fall paths to be" in all_text
    assert document.summary.rwp_labels == ["rwp.1", "rwp.2", "rwp.3", "rwp.4", "rwp.5"]
    assert document.summary.rooflight_rectangle_count >= 5
    assert any(block.text_class == "rooflight_label" for block in document.text_blocks)
    assert viewport.bbox_pdf[2] < title_block.bbox_pdf[0]


def test_vector_endpoint_returns_uploaded_document(
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
        vector_response = client.get(f"/api/documents/{document_id}/vector")

    assert upload_response.status_code == 201
    assert vector_response.status_code == 200
    data = vector_response.json()
    assert data["document_id"] == document_id
    assert data["summary"]["rwp_label_count"] == 5
    assert data["summary"]["rooflight_rectangle_count"] >= 5
    assert data["summary"]["vector_primitive_count"] >= 20_000
