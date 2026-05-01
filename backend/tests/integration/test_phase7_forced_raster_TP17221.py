from pathlib import Path

from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.config import Settings
from app.main import create_app


def test_forced_raster_tp17221_produces_usable_review_required_polygon(
    tp17221_raster_clean_pdf: Path,
    tmp_path: Path,
) -> None:
    app = create_app(
        Settings(storage_root=tmp_path, raster_render_dpi=80, raster_ocr_provider="mock")
    )

    with TestClient(app) as client, tp17221_raster_clean_pdf.open("rb") as upload:
        upload_response = client.post(
            "/api/documents",
            files={"file": (tp17221_raster_clean_pdf.name, upload, "application/pdf")},
        )
        document_id = upload_response.json()["document_id"]
        extract_response = client.post(
            f"/api/documents/{document_id}/extract",
            json={"force_pipeline": "raster_first"},
        )

    assert extract_response.status_code == 200
    data = extract_response.json()
    schema = data["production_schema"]
    polygon = Polygon(schema["target_area"]["outer_polygon_mm"])
    assert polygon.is_valid
    assert polygon.exterior.is_ring
    assert len(schema["constraints"]["rainwater_outlets"]) >= 3
    assert schema["quality_checks"]["excludes_title_block"]
    assert schema["quality_checks"]["human_review_status"] == "required"
    assert data["image_derived_primitives"][0]["source"] == "image_derived"
