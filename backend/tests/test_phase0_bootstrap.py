from pathlib import Path

import fitz
from fastapi.testclient import TestClient

from app.main import app


def test_health_endpoint() -> None:
    response = TestClient(app).get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_sample_pdfs_open_with_pymupdf(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        assert pdf_path.exists(), f"Missing sample fixture: {pdf_path}"
        with fitz.open(pdf_path) as document:
            assert document.page_count >= 1
