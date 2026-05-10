from pathlib import Path

from fastapi.testclient import TestClient
from shapely.geometry import Polygon

from app.config import Settings
from app.main import create_app
from app.models.production import ProductionSchema
from app.models.vector import (
    PageMetadata,
    RooflightRectangle,
    TextBlock,
    VectorDocument,
    VectorExtractionSummary,
    VectorPrimitive,
)
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.finalize import _rainwater_outlets, _rooflights, build_production_schema
from app.services.vector_pipeline.extractor import extract_vector_document


def _build_schema(pdf_path: Path) -> ProductionSchema:
    provider = MockProvider()
    vector_document = extract_vector_document(pdf_path, pdf_path.stem, provider)
    candidate_document = generate_candidate_document(vector_document, source_path=pdf_path)
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
    assert len(schema.constraints.rainwater_outlets) >= 4
    assert schema.quality_checks.contains_or_borders_rwp is True
    assert len(schema.constraints.rooflights) == 5
    assert schema.quality_checks.contains_rooflights is True
    assert schema.target_area.geometry_source == "vector_raster_refined_region"
    assert schema.target_area.area_m2_estimated < 140.0
    assert schema.coordinate_systems.cad.calibration_source == "detected_scale_text"
    assert schema.quality_checks.human_review_status == "required"
    assert schema.target_area.confidence <= 0.7
    assert schema.quality_checks.cad_candidate_exportable is False
    assert "candidate_area_outlier" not in schema.quality_checks.warnings
    assert "synthetic_gap_bridges_used" not in schema.quality_checks.warnings
    assert "target_overlaps_title_block" not in schema.quality_checks.warnings
    assert "raster_disagreement" not in schema.quality_checks.warnings
    assert "rooflight_detection_requires_review" not in schema.quality_checks.warnings
    assert "raster_refined_candidate_requires_review" in schema.quality_checks.warnings
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


def test_rainwater_outlets_are_filtered_and_snapped_to_selected_polygon() -> None:
    vector_document = _minimal_vector_document(
        text_blocks=[
            TextBlock(id="rwp_1", page_number=1, text="RWP.1", bbox_pdf=[124, 46, 136, 54]),
            TextBlock(id="rwp_2", page_number=1, text="RWP.2", bbox_pdf=[450, 250, 470, 265]),
        ],
        vector_primitives=[
            VectorPrimitive(
                id="drain_1",
                page_number=1,
                type="rect",
                bbox_pdf=[126, 46, 134, 54],
                stroke_width=1,
                semantic_role="drainage_symbol",
            )
        ],
    )

    outlets = _rainwater_outlets(
        vector_document,
        Polygon([[0, 0], [100, 0], [100, 100], [0, 100]]),
        0,
        0,
        1.0,
    )

    assert [outlet.id for outlet in outlets] == ["rwp.1"]
    assert outlets[0].point_mm == [100.0, 50.0]
    assert outlets[0].source.endswith("snapped_to_target_boundary")


def test_rooflights_use_pv_exclusion_and_high_confidence_geometry() -> None:
    vector_document = _minimal_vector_document(
        text_blocks=[
            TextBlock(id="pv", page_number=1, text="PV ARRAY", bbox_pdf=[5, 5, 25, 25]),
            TextBlock(id="rl", page_number=1, text="ROOFLIGHT SCHEDULE", bbox_pdf=[400, 20, 500, 40]),
        ],
        rooflight_rectangles=[
            RooflightRectangle(
                id="pv_like_rect",
                page_number=1,
                bbox_pdf=[8, 8, 22, 22],
                source="axis_aligned_rect",
                confidence=0.95,
            ),
            RooflightRectangle(
                id="real_rect",
                page_number=1,
                bbox_pdf=[70, 70, 90, 90],
                source="axis_aligned_rect",
                confidence=0.82,
            ),
        ],
    )

    rooflights = _rooflights(
        vector_document,
        Polygon([[0, 0], [100, 0], [100, 100], [0, 100]]),
        0,
        0,
        1.0,
    )

    assert len(rooflights) == 1
    assert rooflights[0].polygon_mm == [[70.0, 70.0], [90.0, 70.0], [90.0, 90.0], [70.0, 90.0]]
    assert rooflights[0].confidence == 0.7


def _minimal_vector_document(
    *,
    text_blocks: list[TextBlock] | None = None,
    vector_primitives: list[VectorPrimitive] | None = None,
    rooflight_rectangles: list[RooflightRectangle] | None = None,
) -> VectorDocument:
    return VectorDocument(
        document_id="synthetic",
        source_file="synthetic.pdf",
        page_metadata=[
            PageMetadata(
                page_number=1,
                page_width=600,
                page_height=400,
                rotation=0,
                media_box=[0, 0, 600, 400],
                crop_box=[0, 0, 600, 400],
            )
        ],
        text_blocks=text_blocks or [],
        classified_text_blocks=[],
        vector_primitives=vector_primitives or [],
        sheet_regions=[],
        rooflight_rectangles=rooflight_rectangles or [],
        summary=VectorExtractionSummary(
            text_block_count=len(text_blocks or []),
            classified_text_block_count=0,
            vector_primitive_count=len(vector_primitives or []),
            sheet_region_count=0,
            rwp_label_count=0,
            rwp_labels=[],
            rooflight_rectangle_count=len(rooflight_rectangles or []),
        ),
    )
