from pathlib import Path

import fitz
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.services.raster_pipeline.pipeline import run_raster_pipeline
from app.services.raster_pipeline.rendering import render_pdf_for_raster


@pytest.fixture
def multipage_pdf(tmp_path: Path) -> Path:
    source_path = tmp_path / "multipage.pdf"
    with fitz.open() as document:
        for width, height in [(300, 200), (400, 300)]:
            page = document.new_page(width=width, height=height)
            page.draw_rect(fitz.Rect(30, 30, width - 30, height - 30))
            page.insert_text((40, 50), "Roof Plan 1:50")
        document.save(source_path)
    return source_path


@pytest.fixture
def raster_settings(tmp_path: Path) -> Settings:
    return Settings(
        storage_root=tmp_path / "storage",
        raster_render_dpi=72,
        raster_preview_dpi=36,
        raster_ocr_provider="mock",
        segmentation_provider="noop",
        ai_provider="mock",
        allow_live_ai_calls=False,
    )


@pytest.mark.parametrize("page_index, dimensions", [(0, (300, 200)), (1, (400, 300))])
def test_raster_pipeline_uses_selected_page(
    multipage_pdf: Path,
    raster_settings: Settings,
    page_index: int,
    dimensions: tuple[int, int],
) -> None:
    result = run_raster_pipeline(
        source_path=multipage_pdf,
        document_id="selected-page",
        settings=raster_settings,
        page_index=page_index,
    )

    assert result.render.page_index == page_index
    assert (result.render.width_px, result.render.height_px) == dimensions
    coordinates = result.production_schema.coordinate_systems.pdf
    assert (coordinates.page_width, coordinates.page_height) == dimensions
    assert result.human_review_status == "required"
    assert result.ocr_audit.live_calls == 0


@pytest.mark.parametrize(
    "body, expected_page",
    [
        (None, 0),
        ({}, 0),
        ({"page_index": 1}, 1),
        ({"force_pipeline": "raster_first", "page_index": 1}, 1),
    ],
)
def test_extract_endpoint_defaults_to_raster_and_honors_page(
    multipage_pdf: Path,
    raster_settings: Settings,
    body: dict[str, object] | None,
    expected_page: int,
) -> None:
    with TestClient(create_app(raster_settings)) as client, multipage_pdf.open("rb") as upload:
        uploaded = client.post(
            "/api/documents", files={"file": (multipage_pdf.name, upload, "application/pdf")}
        )
        assert uploaded.status_code == 201
        document_id = uploaded.json()["document_id"]
        response = client.post(f"/api/documents/{document_id}/extract", json=body)

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["pipeline"] == "raster_first"
    assert payload["render"]["page_index"] == expected_page
    assert payload["render"]["width_px"] == (300 if expected_page == 0 else 400)
    assert payload["human_review_status"] == "required"


@pytest.mark.parametrize("page_index", [-1, 2, 1.5, "1"])
def test_extract_endpoint_rejects_invalid_page(
    multipage_pdf: Path,
    raster_settings: Settings,
    page_index: object,
) -> None:
    with TestClient(create_app(raster_settings)) as client, multipage_pdf.open("rb") as upload:
        uploaded = client.post(
            "/api/documents", files={"file": (multipage_pdf.name, upload, "application/pdf")}
        )
        document_id = uploaded.json()["document_id"]
        response = client.post(
            f"/api/documents/{document_id}/extract",
            json={"force_pipeline": "raster_first", "page_index": page_index},
        )

    assert response.status_code == 422
    assert "page_index" in response.text


def test_explicit_vector_extraction_is_preserved(
    multipage_pdf: Path,
    raster_settings: Settings,
) -> None:
    with TestClient(create_app(raster_settings)) as client, multipage_pdf.open("rb") as upload:
        uploaded = client.post(
            "/api/documents", files={"file": (multipage_pdf.name, upload, "application/pdf")}
        )
        document_id = uploaded.json()["document_id"]
        response = client.post(
            f"/api/documents/{document_id}/extract", json={"force_pipeline": "vector_first"}
        )

    assert response.status_code == 200, response.text
    assert len(response.json()["page_metadata"]) == 2
    assert response.json()["vector_primitives"]


@pytest.mark.parametrize("page_index", [-1, 2])
def test_renderer_rejects_out_of_range_pages(
    multipage_pdf: Path,
    raster_settings: Settings,
    page_index: int,
) -> None:
    with pytest.raises(ValueError, match="page_index.*out of range"):
        render_pdf_for_raster(
            source_path=multipage_pdf,
            document_id="invalid-page",
            settings=raster_settings,
            page_index=page_index,
        )