from pathlib import Path

from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def test_raster_dxf_export_blocked_until_approval(
    tp17221_raster_clean_pdf: Path,
    tmp_path: Path,
) -> None:
    app = create_app(
        Settings(
            storage_root=tmp_path,
            raster_render_dpi=80,
            raster_ocr_provider="mock",
            segmentation_provider="noop",
            allow_live_ai_calls=False,
            google_api_key=None,
        )
    )

    with TestClient(app) as client, tp17221_raster_clean_pdf.open("rb") as upload:
        upload_response = client.post(
            "/api/documents",
            files={"file": (tp17221_raster_clean_pdf.name, upload, "application/pdf")},
        )
        document_id = upload_response.json()["document_id"]
        extract_response = client.post(
            f"/api/documents/{document_id}/extract",
        )
        preview_export = client.post(f"/api/documents/{document_id}/export")
        blocked_export = client.post(
            f"/api/documents/{document_id}/export",
            json={"pipeline": "raster", "formats": ["dxf"]},
        )
        approval_response = client.post(
            f"/api/documents/{document_id}/approve",
            json={
                "approved_by": "test",
                "target_area": {"outer_polygon_mm": [[0, 0], [1, 0], [1, 1]], "holes": []},
                "constraints": {"rainwater_outlets": [], "rooflights": [], "excluded_regions": []},
            },
        )
        allowed_export = client.post(
            f"/api/documents/{document_id}/export",
            json={"pipeline": "raster", "formats": ["dxf", "metadata_json"]},
        )

    assert extract_response.status_code == 200
    assert extract_response.json()["pipeline"] == "raster_first"
    assert preview_export.status_code == 200
    preview_exports = preview_export.json()["exports"]
    assert preview_exports["dxf"] is None
    assert preview_exports["svg"] is not None
    assert preview_exports["geojson"] is not None
    assert preview_exports["mask_png"] is not None
    assert preview_exports["metadata_json"] is not None
    assert blocked_export.status_code == 409
    assert approval_response.json()["export_unlocked"] is True
    assert allowed_export.status_code == 200
