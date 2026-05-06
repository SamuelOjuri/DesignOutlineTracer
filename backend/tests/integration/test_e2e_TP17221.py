import json
from pathlib import Path

from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.config import Settings
from app.main import create_app
from app.services.audit import audit_path


def test_e2e_tp17221_vector_pipeline_export_and_audit(
    tp17221_pdf: Path,
    tmp_path: Path,
) -> None:
    app = create_app(Settings(storage_root=tmp_path, ai_provider="mock"))

    with TestClient(app) as client, tp17221_pdf.open("rb") as upload:
        upload_response = client.post(
            "/api/documents",
            files={"file": (tp17221_pdf.name, upload, "application/pdf")},
            headers={"X-Request-ID": "test-e2e-tp17221"},
        )
        document_id = upload_response.json()["document_id"]
        vector_response = client.get(f"/api/documents/{document_id}/vector")
        candidates_response = client.get(f"/api/documents/{document_id}/candidates")
        validation_response = client.post(f"/api/documents/{document_id}/validate")
        blocked_dxf_response = client.post(f"/api/documents/{document_id}/export")
        export_response = client.post(
            f"/api/documents/{document_id}/export",
            json={"formats": ["svg", "geojson", "mask_png", "metadata_json"]},
        )

    assert upload_response.status_code == 201
    assert upload_response.headers["X-Request-ID"] == "test-e2e-tp17221"
    assert vector_response.status_code == 200
    assert candidates_response.status_code == 200
    assert validation_response.status_code == 200
    assert blocked_dxf_response.status_code == 409
    assert export_response.status_code == 200

    vector = vector_response.json()
    candidates = candidates_response.json()
    validation = validation_response.json()
    export = export_response.json()
    schema = export["production_schema"]
    polygon = Polygon(schema["target_area"]["outer_polygon_mm"])

    assert vector["summary"]["rwp_label_count"] >= 5
    assert candidates["summary"]["roof_scope_candidate_rank"] == 1
    assert candidates["summary"]["top_candidate_id"] != "candidate_coarse_semantic_search_01"
    assert "candidate_vector_anchor_boundary_01" in candidates["summary"][
        "review_candidate_ids"
    ]
    assert validation["validation"]["selected_candidate_id"] != (
        "candidate_coarse_semantic_search_01"
    )
    assert validation["validation"]["selected_candidate_id"] == (
        "candidate_vector_anchor_boundary_01"
    )
    assert validation["validation"]["selected_auto_export_candidate_id"] is None
    assert validation["validation"]["review_required"] is True
    assert schema["target_area"]["review_required"] is True
    assert schema["target_area"]["geometry_source"] == "anchor_boundary_reconstruction"
    assert schema["coordinate_systems"]["cad"]["calibration_source"] != (
        "accuroof_reference_area_tp17221"
    )
    assert polygon.is_valid
    assert polygon.exterior.is_ring
    assert len(schema["constraints"]["rainwater_outlets"]) >= 5
    assert schema["quality_checks"]["self_intersections"] is False
    assert schema["quality_checks"]["human_review_status"] == "required"

    assert export["exports"]["dxf"] is None
    for key in ("svg", "geojson", "mask_png", "metadata_json"):
        assert (tmp_path / export["exports"][key]).exists()

    audit_file = audit_path(tmp_path, document_id)
    audit = json.loads(audit_file.read_text(encoding="utf-8"))
    event_types = [event["event_type"] for event in audit["events"]]
    assert "document_uploaded" in event_types
    assert "vector_extracted" in event_types
    assert "candidates_generated" in event_types
    assert "candidates_validated" in event_types
    assert "document_exported" in event_types
