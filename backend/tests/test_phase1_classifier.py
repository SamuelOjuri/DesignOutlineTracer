import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.classifier.pdf_classifier import classify_source


def _golden_path(pdf_path: Path) -> Path:
    return Path(__file__).parent / "fixtures" / "golden" / pdf_path.stem / "phase1.json"


def _assert_classification_matches_golden(pdf_path: Path) -> None:
    expected = json.loads(_golden_path(pdf_path).read_text(encoding="utf-8"))
    actual = classify_source(pdf_path, pdf_path.name).model_dump(mode="json")

    exact_fields = [
        "has_extractable_text",
        "text_character_count",
        "has_vector_paths",
        "vector_path_count",
        "embedded_image_count",
        "large_page_image_detected",
        "recommended_pipeline",
        "source_type",
        "page_count",
        "font_count",
        "estimated_dpi",
        "confidence",
        "signals",
        "pages",
    ]
    for field in exact_fields:
        assert actual[field] == expected[field]

    assert actual["embedded_image_area_ratio"] == expected["embedded_image_area_ratio"]


def test_classifier_matches_golden_for_all_sample_pdfs(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        _assert_classification_matches_golden(pdf_path)


def test_tp17221_is_vector_pdf(tp17221_pdf: Path) -> None:
    classification = classify_source(tp17221_pdf, tp17221_pdf.name)

    assert classification.source_type == "vector_pdf"
    assert classification.recommended_pipeline == "vector_first"
    assert classification.vector_path_count >= 10_000
    assert classification.text_character_count >= 4_000


def test_upload_document_persists_file_and_returns_classification(
    tp17221_pdf: Path,
    tmp_path: Path,
) -> None:
    app = create_app(Settings(storage_root=tmp_path, ai_provider="mock"))

    with TestClient(app) as client, tp17221_pdf.open("rb") as upload:
        response = client.post(
            "/api/documents",
            files={"file": (tp17221_pdf.name, upload, "application/pdf")},
        )

    assert response.status_code == 201
    data = response.json()
    assert data["document_id"]
    assert data["original_filename"] == tp17221_pdf.name
    assert data["stored_path"].startswith(f"uploads/{data['document_id']}/")
    assert data["preview_png_path"] == f"uploads/{data['document_id']}/preview.png"
    assert (tmp_path / data["stored_path"]).exists()
    assert (tmp_path / data["preview_png_path"]).exists()
    assert data["classification"]["source_type"] == "vector_pdf"
    assert data["classification"]["recommended_pipeline"] == "vector_first"
