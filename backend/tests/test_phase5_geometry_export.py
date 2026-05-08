from pathlib import Path

from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.config import Settings
from app.main import create_app
from app.models.production import ProductionSchema
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.finalize import build_production_schema
from app.services.vector_pipeline.extractor import extract_vector_document


def _build_schema(pdf_path: Path) -> ProductionSchema:
    provider = MockProvider()
    vector_document = extract_vector_document(pdf_path, pdf_path.stem, provider)
    candidate_document = generate_candidate_document(vector_document)
    validation = provider.validate_candidates(
        candidate_document=candidate_document,
        text_blocks=vector_document.text_blocks,
        overlay_png_path=None,
    )
    return build_production_schema(
        document_id=pdf_path.stem,
        source_file=pdf_path.name,
        vector_document=vector_document,
        candidate_document=candidate_document,
        validation=validation,
    )


def test_finalized_schema_matches_golden_for_all_sample_pdfs(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        schema = _build_schema(pdf_path)

        assert schema.target_area.area_m2_estimated > 0
        assert schema.quality_checks.human_review_status == "required"
        assert schema.target_area.review_required
        assert schema.coordinate_systems.cad.calibration_source != "accuroof_reference_area_tp17221"
        assert schema.coordinate_systems.cad.requires_user_confirmation
        assert schema.quality_checks.polygon_closed
        assert schema.quality_checks.self_intersections is False


def test_tp17221_finalized_geometry_requires_review(tp17221_pdf: Path) -> None:
    schema = _build_schema(tp17221_pdf)
    polygon = Polygon(schema.target_area.outer_polygon_mm)

    assert polygon.is_valid
    assert polygon.exterior.is_ring
    assert schema.quality_checks.self_intersections is False
    assert len(schema.constraints.rainwater_outlets) >= 5
    assert len(schema.constraints.rooflights) == 0
    assert schema.quality_checks.contains_rooflights is False
    assert schema.target_area.geometry_source == "anchor_boundary_reconstruction"
    assert schema.target_area.area_m2_estimated > 100.0
    assert schema.coordinate_systems.cad.calibration_source == "detected_scale_text"
    assert schema.quality_checks.human_review_status == "required"
    assert schema.target_area.confidence <= 0.58
    assert schema.quality_checks.cad_candidate_exportable is False
    assert "candidate_area_outlier" in schema.quality_checks.warnings
    assert "rooflight_detection_requires_review" in schema.quality_checks.warnings
    assert "scale_requires_user_confirmation" in schema.quality_checks.warnings


def test_export_endpoint_blocks_dxf_until_review(
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
        export_response = client.post(f"/api/documents/{document_id}/export")

    assert upload_response.status_code == 201
    assert export_response.status_code == 409
    assert "human_review_required" in export_response.text
    assert "scale_requires_confirmation" in export_response.text


def test_export_endpoint_writes_review_preview_formats(
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
        export_response = client.post(
            f"/api/documents/{document_id}/export",
            json={"formats": ["svg", "geojson", "mask_png", "metadata_json"]},
        )

    assert upload_response.status_code == 201
    assert export_response.status_code == 200
    data = export_response.json()
    exports = data["exports"]
    assert exports["dxf"] is None
    for key in ("svg", "geojson", "mask_png", "metadata_json"):
        assert exports[key]
        assert "review_preview" in exports[key]
        assert (tmp_path / exports[key]).exists()
    assert data["production_schema"]["target_area"]["review_required"] is True


def test_export_endpoint_uses_original_pdf_after_validation_overlay(
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
        export_response = client.post(
            f"/api/documents/{document_id}/export",
            json={"formats": ["svg", "geojson", "mask_png", "metadata_json"]},
        )

    assert validation_response.status_code == 200
    assert export_response.status_code == 200
    data = export_response.json()
    assert data["production_schema"]["document"]["source_file"] == tp17221_pdf.name
    assert data["production_schema"]["target_area"]["geometry_source"] == (
        "vector_raster_refined_region"
    )
    assert data["production_schema"]["target_area"]["semantic_validation_source"] == (
        "mock-deterministic-v1"
    )
    assert data["production_schema"]["coordinate_systems"]["cad"]["calibration_source"] != (
        "accuroof_reference_area_tp17221"
    )
