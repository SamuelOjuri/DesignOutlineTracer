from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from shapely.geometry import LineString, Point, Polygon

from app.config import Settings
from app.main import create_app
from app.models.candidates import CandidateDocument, CandidateRegion
from app.models.vector import (
    PageMetadata,
    RooflightRectangle,
    TextBlock,
    VectorDocument,
    VectorExtractionSummary,
    VectorPrimitive,
)
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import (
    Anchor,
    _bbox_center,
    _non_target_roof_regions,
    _refine_scope_boundary_to_linework,
    _trim_to_flat_roof_evidence_band,
    generate_candidate_document,
)
from app.services.vector_pipeline.extractor import extract_vector_document


def _generate_candidates(pdf_path: Path) -> CandidateDocument:
    vector_document = extract_vector_document(pdf_path, pdf_path.stem, MockProvider())
    return generate_candidate_document(vector_document, source_path=pdf_path)


def test_candidate_generation_matches_golden_summaries_for_all_sample_pdfs(
    tp17202_pdf: Path,
    tp17221_pdf: Path,
    tp17256_pdf: Path,
) -> None:
    for pdf_path in (tp17202_pdf, tp17221_pdf, tp17256_pdf):
        actual = _generate_candidates(pdf_path)

        assert actual.summary.candidate_count == len(actual.candidate_regions)
        assert actual.candidate_regions == sorted(
            actual.candidate_regions,
            key=lambda candidate: candidate.score,
            reverse=True,
        )
        assert actual.summary.top_candidate_id == actual.candidate_regions[0].id
        for candidate in actual.candidate_regions:
            if candidate.geometry_source == "coarse_semantic_search_area":
                assert not candidate.eligible_for_auto_export
                assert candidate.review_required
                assert "not_cad_final_geometry" in candidate.quality_warnings


def test_raster_refined_candidate_restores_scope_and_reconstruction_remains_review_only(
    tp17221_pdf: Path,
) -> None:
    candidates = _generate_candidates(tp17221_pdf)
    refined_candidate = next(
        candidate
        for candidate in candidates.candidate_regions
        if candidate.geometry_source == "vector_raster_refined_region"
    )
    reconstructed_candidate = next(
        candidate
        for candidate in candidates.candidate_regions
        if candidate.geometry_source == "anchor_boundary_reconstruction"
    )
    coarse_candidate = next(
        candidate
        for candidate in candidates.candidate_regions
        if candidate.geometry_source == "coarse_semantic_search_area"
    )

    assert candidates.candidate_regions[0] == refined_candidate
    assert refined_candidate.raster_iou is not None
    assert refined_candidate.raster_iou >= 0.6
    assert refined_candidate.raster_clip_iou is not None
    assert refined_candidate.raster_clip_iou >= 0.85
    assert refined_candidate.bbox_pdf[0] > 500
    assert 1600 <= refined_candidate.bbox_pdf[2] <= 1660
    assert refined_candidate.features.rooflight_count == 5
    assert refined_candidate.features.rwp_label_count == 4
    assert refined_candidate.area_pdf_units < reconstructed_candidate.area_pdf_units
    assert "synthetic_gap_bridges_used" not in refined_candidate.quality_warnings
    assert "overlaps_title_block" not in refined_candidate.quality_warnings
    assert "raster_refined_candidate_requires_review" in refined_candidate.quality_warnings
    assert refined_candidate.safety_status == "review"
    assert refined_candidate.eligible_for_auto_export
    assert not refined_candidate.eligible_for_final_dxf
    assert refined_candidate.review_required
    assert reconstructed_candidate.safety_status == "review"
    assert not reconstructed_candidate.eligible_for_auto_export
    assert reconstructed_candidate.eligible_for_review_selection
    assert not reconstructed_candidate.eligible_for_final_dxf
    assert reconstructed_candidate.features.rwp_label_count == 5
    assert reconstructed_candidate.area_pdf_units > refined_candidate.area_pdf_units
    assert "candidate_area_outlier" in reconstructed_candidate.quality_warnings
    assert "anchor_boundary_reconstruction_requires_review" in (
        reconstructed_candidate.quality_warnings
    )
    assert reconstructed_candidate.id in candidates.summary.review_candidate_ids
    assert candidates.candidate_regions[0].geometry_source == "vector_raster_refined_region"
    assert candidates.candidate_regions[0].eligible_for_auto_export
    assert candidates.candidate_regions[0].review_required
    assert coarse_candidate.rank > candidates.candidate_regions[0].rank
    assert coarse_candidate.features.contains_rooflights
    assert coarse_candidate.features.rwp_label_count == 5
    assert coarse_candidate.score < candidates.candidate_regions[0].score

    for candidate in candidates.candidate_regions:
        if candidate.features.overlaps_title_block or candidate.features.overlaps_pv_array:
            assert candidate.rank > candidates.candidate_regions[0].rank


def test_tp17221_refined_candidate_matches_validation_mask(
    tp17221_pdf: Path,
    docs_dir: Path,
) -> None:
    vector_document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, MockProvider())
    candidates = generate_candidate_document(vector_document, source_path=tp17221_pdf)
    refined_candidate = candidates.candidate_regions[0]
    page = vector_document.page_metadata[0]

    metrics = _validation_mask_metrics(
        refined_candidate,
        docs_dir / "validation" / "TP17221_2501_mask.jpg",
        page_width=page.page_width,
        page_height=page.page_height,
    )

    assert refined_candidate.geometry_source == "vector_raster_refined_region"
    assert metrics["iou"] >= 0.91
    assert metrics["precision"] >= 0.96
    assert metrics["recall"] >= 0.93
    assert 0.93 <= metrics["area_ratio"] <= 1.02


def test_evidence_band_trim_removes_unsupported_upper_shelf() -> None:
    polygon = Polygon(
        [
            [100, 100],
            [100, 320],
            [250, 320],
            [250, 240],
            [500, 240],
            [500, 100],
        ]
    )
    rooflight = RooflightRectangle(
        id="rooflight_1",
        page_number=1,
        bbox_pdf=[360, 190, 420, 230],
        source="synthetic",
        confidence=0.9,
    )
    rwp_anchor = Anchor(id="rwp.1", point=Point(450, 255), bbox=[430, 248, 470, 262])
    rooflight_anchor = Anchor(
        id=rooflight.id,
        point=_bbox_center(rooflight.bbox_pdf),
        bbox=rooflight.bbox_pdf,
    )

    trimmed = _trim_to_flat_roof_evidence_band(
        polygon=polygon,
        vector_document=_minimal_vector_document(
            vector_primitives=[
                VectorPrimitive(
                    id="step_line",
                    page_number=1,
                    type="line",
                    bbox_pdf=[300, 170, 500, 170],
                    start_pdf=[300, 170],
                    end_pdf=[500, 170],
                    stroke_width=1,
                    semantic_role="roof_perimeter",
                )
            ],
            rooflight_rectangles=[rooflight],
        ),
        rwp_anchors=[rwp_anchor],
        rooflight_anchors=[rooflight_anchor],
        vector_linework=[LineString([(300, 170), (500, 170)])],
    )

    assert trimmed.area < polygon.area * 0.85
    assert not trimmed.contains(Point(450, 130))
    assert trimmed.contains(Point(450, 200))
    assert trimmed.contains(Point(180, 130))
    assert trimmed.distance(rwp_anchor.point) <= 80
    assert trimmed.contains(rooflight_anchor.point)


def test_boundary_refinement_trims_anchor_free_left_shoulder() -> None:
    polygon = Polygon(
        [
            [100, 100],
            [100, 520],
            [600, 520],
            [520, 210],
            [360, 210],
            [360, 100],
        ]
    )
    rooflight = RooflightRectangle(
        id="rooflight_1",
        page_number=1,
        bbox_pdf=[450, 225, 530, 300],
        source="synthetic",
        confidence=0.9,
    )
    rwp_anchor = Anchor(id="rwp.1", point=Point(560, 480), bbox=[540, 472, 580, 488])
    rooflight_anchor = Anchor(
        id=rooflight.id,
        point=_bbox_center(rooflight.bbox_pdf),
        bbox=rooflight.bbox_pdf,
    )

    refined = _refine_scope_boundary_to_linework(
        polygon=polygon,
        vector_document=_minimal_vector_document(
            vector_primitives=[
                VectorPrimitive(
                    id="left_shoulder_boundary",
                    page_number=1,
                    type="line",
                    bbox_pdf=[80, 210, 360, 210],
                    start_pdf=[80, 210],
                    end_pdf=[360, 210],
                    stroke_width=1,
                    semantic_role="roof_perimeter",
                )
            ],
            rooflight_rectangles=[rooflight],
            page_height=560,
        ),
        rwp_anchors=[rwp_anchor],
        rooflight_anchors=[rooflight_anchor],
        vector_linework=[LineString([(80, 210), (360, 210)])],
    )

    assert refined.area < polygon.area * 0.85
    assert not refined.contains(Point(180, 150))
    assert refined.contains(Point(180, 260))
    assert refined.contains(rooflight_anchor.point)
    assert refined.distance(rwp_anchor.point) <= 80
    assert refined.is_valid


def test_candidates_endpoint_returns_ranked_candidates(
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
        candidates_response = client.get(f"/api/documents/{document_id}/candidates")

    assert upload_response.status_code == 201
    assert candidates_response.status_code == 200
    data = candidates_response.json()
    assert data["document_id"] == document_id
    assert data["summary"]["top_candidate_id"] != "candidate_coarse_semantic_search_01"
    assert data["summary"]["roof_scope_candidate_rank"] is not None
    assert data["summary"]["roof_scope_candidate_rank"] <= 3
    assert data["candidate_regions"][0]["geometry_source"] == "vector_raster_refined_region"
    assert data["candidate_regions"][0]["raster_iou"] >= 0.6
    assert data["candidate_regions"][0]["raster_clip_iou"] >= 0.85
    assert "candidate_vector_anchor_boundary_01" in data["summary"]["review_candidate_ids"]
    assert "candidate_vector_raster_refined_01" in data["summary"]["review_candidate_ids"]
    auto_export_candidate = next(
        candidate
        for candidate in data["candidate_regions"]
        if candidate["eligible_for_auto_export"]
    )
    assert auto_export_candidate["safety_status"] != "blocked"
    assert data["candidate_regions"][-1]["geometry_source"] == "coarse_semantic_search_area"


def test_existing_pitched_roof_note_becomes_non_target_exclusion() -> None:
    vector_document = VectorDocument(
        document_id="semantic-exclusion",
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
        text_blocks=[
            TextBlock(
                id="text_001",
                page_number=1,
                text="EXISTING PITCHED ROOF",
                bbox_pdf=[40, 90, 120, 115],
                **{"class": "general_note"},
            )
        ],
        classified_text_blocks=[],
        vector_primitives=[],
        sheet_regions=[],
        rooflight_rectangles=[],
        summary=VectorExtractionSummary(
            text_block_count=1,
            classified_text_block_count=0,
            vector_primitive_count=0,
            sheet_region_count=0,
            rwp_label_count=0,
            rwp_labels=[],
            rooflight_rectangle_count=0,
        ),
    )

    regions = _non_target_roof_regions(vector_document)

    assert len(regions) == 3
    assert regions[0].contains(Point(100, 100))
    assert any(region.contains(Point(320, 100)) for region in regions)
    assert sum(region.area for region in regions) > 100_000


def _validation_mask_metrics(
    candidate: CandidateRegion,
    validation_mask_path: Path,
    *,
    page_width: float,
    page_height: float,
) -> dict[str, float]:
    image = np.array(Image.open(validation_mask_path).convert("RGB"))
    red = image[:, :, 0]
    green = image[:, :, 1]
    blue = image[:, :, 2]
    target_mask = ((green > 100) & (blue > 100) & (red < 220)).astype("uint8")
    component_count, labels, stats, _ = cv2.connectedComponentsWithStats(target_mask, 8)
    assert component_count > 1
    largest_component = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    target = labels == largest_component

    height, width = target.shape
    prediction = Image.new("1", (width, height), 0)
    ImageDraw.Draw(prediction).polygon(
        [(x / page_width * width, y / page_height * height) for x, y in candidate.polygon_pdf],
        fill=1,
    )
    predicted = np.array(prediction).astype(bool)
    intersection = int((predicted & target).sum())
    union = int((predicted | target).sum())
    predicted_area = int(predicted.sum())
    target_area = int(target.sum())
    return {
        "iou": intersection / union,
        "precision": intersection / predicted_area,
        "recall": intersection / target_area,
        "area_ratio": predicted_area / target_area,
    }


def _minimal_vector_document(
    *,
    vector_primitives: list[VectorPrimitive] | None = None,
    rooflight_rectangles: list[RooflightRectangle] | None = None,
    page_width: float = 600,
    page_height: float = 400,
) -> VectorDocument:
    return VectorDocument(
        document_id="synthetic",
        source_file="synthetic.pdf",
        page_metadata=[
            PageMetadata(
                page_number=1,
                page_width=page_width,
                page_height=page_height,
                rotation=0,
                media_box=[0, 0, page_width, page_height],
                crop_box=[0, 0, page_width, page_height],
            )
        ],
        text_blocks=[],
        classified_text_blocks=[],
        vector_primitives=vector_primitives or [],
        sheet_regions=[],
        rooflight_rectangles=rooflight_rectangles or [],
        summary=VectorExtractionSummary(
            text_block_count=0,
            classified_text_block_count=0,
            vector_primitive_count=len(vector_primitives or []),
            sheet_region_count=0,
            rwp_label_count=0,
            rwp_labels=[],
            rooflight_rectangle_count=len(rooflight_rectangles or []),
        ),
    )
