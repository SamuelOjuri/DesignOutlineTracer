import json
from pathlib import Path
from typing import cast

import ezdxf
from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.config import Settings
from app.main import create_app
from app.models.production import ProductionSchema
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.finalize import build_production_schema
from app.services.vector_pipeline.extractor import extract_vector_document


def _golden_path(pdf_path: Path) -> Path:
    return Path(__file__).parent / "fixtures" / "golden" / pdf_path.stem / "phase5.json"


def _phase5_golden(pdf_path: Path) -> dict[str, object]:
    return cast(dict[str, object], json.loads(_golden_path(pdf_path).read_text(encoding="utf-8")))


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
        actual = {
            "area_m2_estimated": schema.target_area.area_m2_estimated,
            "outlet_count": len(schema.constraints.rainwater_outlets),
            "rooflight_count": len(schema.constraints.rooflights),
            "human_review_status": schema.quality_checks.human_review_status,
            "scale": schema.coordinate_systems.cad.scale,
            "calibration_source": schema.coordinate_systems.cad.calibration_source,
            "polygon_closed": schema.quality_checks.polygon_closed,
            "self_intersections": schema.quality_checks.self_intersections,
        }
        assert actual == _phase5_golden(pdf_path)


def test_tp17221_finalized_geometry_meets_quality_gates(tp17221_pdf: Path) -> None:
    schema = _build_schema(tp17221_pdf)
    polygon = Polygon(schema.target_area.outer_polygon_mm)

    assert polygon.is_valid
    assert polygon.exterior.is_ring
    assert schema.quality_checks.self_intersections is False
    assert schema.quality_checks.contains_rooflights
    assert schema.quality_checks.contains_or_borders_rwp
    assert len(schema.constraints.rainwater_outlets) >= 5
    assert len(schema.constraints.rooflights) >= 5
    assert abs(schema.target_area.area_m2_estimated - 103.0) / 103.0 <= 0.05


def test_export_endpoint_writes_all_formats_and_dxf_round_trips(
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
    assert export_response.status_code == 200
    data = export_response.json()
    exports = data["exports"]
    for key in ("dxf", "svg", "geojson", "mask_png", "metadata_json"):
        assert exports[key]
        assert (tmp_path / exports[key]).exists()

    ezdxf.readfile(tmp_path / exports["dxf"])  # type: ignore[attr-defined]
    assert data["production_schema"]["target_area"]["area_m2_estimated"] == 103.0
    assert data["production_schema"]["quality_checks"]["self_intersections"] is False


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
        export_response = client.post(f"/api/documents/{document_id}/export")

    assert validation_response.status_code == 200
    assert export_response.status_code == 200
    data = export_response.json()
    assert data["production_schema"]["document"]["source_file"] == tp17221_pdf.name
    assert data["production_schema"]["target_area"]["area_m2_estimated"] == 103.0
