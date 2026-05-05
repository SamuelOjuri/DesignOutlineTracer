from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw
from shapely.geometry import Polygon

from app.config import Settings
from app.main import create_app
from app.models.candidates import CandidateDocument
from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.vector_pipeline.extractor import extract_vector_document


def _generate_candidates(pdf_path: Path) -> CandidateDocument:
    vector_document = extract_vector_document(pdf_path, pdf_path.stem, MockProvider())
    return generate_candidate_document(vector_document)


TP17221_EXPECTED_VALIDATION_MASK = Polygon(
    [
        (212.4, 1150.2),
        (557.4, 1150.2),
        (557.4, 1309.2),
        (894.6, 1309.2),
        (895.2, 1175.4),
        (1211.4, 1175.4),
        (1212.0, 1061.4),
        (1620.6, 1061.4),
        (1620.6, 885.0),
        (1795.2, 884.4),
        (1795.2, 812.4),
        (532.8, 838.8),
        (532.2, 879.6),
        (378.0, 879.6),
        (377.4, 1140.0),
    ]
)


def _candidate_iou(candidate_polygon: list[list[float]], expected: Polygon) -> float:
    candidate = Polygon(candidate_polygon)
    union_area = candidate.union(expected).area
    if union_area <= 0:
        return 0.0
    return float(candidate.intersection(expected).area / union_area)


def _candidate_mask_metrics(
    candidate_polygon: list[list[float]],
    mask_path: Path,
) -> tuple[float, float, float]:
    with Image.open(mask_path).convert("RGB") as image:
        image_array = np.array(image)
        expected = (
            (image_array[:, :, 1] > 170)
            & (image_array[:, :, 2] > 170)
            & (image_array[:, :, 0] < 210)
            & ((image_array[:, :, 2].astype(int) - image_array[:, :, 0].astype(int)) > 10)
        )
        candidate_image = Image.new("1", image.size, 0)
        pdf_scale = image.size[0] / 2384.0
        ImageDraw.Draw(candidate_image).polygon(
            [(x * pdf_scale, y * pdf_scale) for x, y in candidate_polygon],
            fill=1,
        )
        candidate = np.array(candidate_image).astype(bool)
    union = expected | candidate
    if not union.any():
        return 0.0, 0.0, 0.0
    intersection = expected & candidate
    return (
        float(intersection.sum() / union.sum()),
        float(intersection.sum() / expected.sum()),
        float(intersection.sum() / candidate.sum()),
    )


def _candidate_mask_iou(candidate_polygon: list[list[float]], mask_path: Path) -> float:
    return _candidate_mask_metrics(candidate_polygon, mask_path)[0]


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


def test_tp17221_coarse_semantic_area_is_fallback_only(tp17221_pdf: Path) -> None:
    candidates = _generate_candidates(tp17221_pdf)
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

    assert candidates.candidate_regions[0] == reconstructed_candidate
    assert reconstructed_candidate.features.rwp_label_count == 5
    assert reconstructed_candidate.boundary_metrics.bridge_count > 0
    assert reconstructed_candidate.boundary_metrics.synthetic_boundary_ratio > 0
    assert reconstructed_candidate.boundary_metrics.included_positive_anchor_ratio >= 0.45
    assert "pv_array" in candidates.target_scope_intent.exclude_evidence
    assert "tapered_insulation" in candidates.target_scope_intent.include_evidence
    assert any(zone.type == "existing_roof" and zone.excluded for zone in candidates.semantic_zones)
    assert any(zone.type == "pv_array" and zone.excluded for zone in candidates.semantic_zones)
    assert reconstructed_candidate.area_pdf_units > (
        10 * candidates.candidate_regions[1].area_pdf_units
    )
    assert "anchor_boundary_reconstruction_requires_review" in (
        reconstructed_candidate.quality_warnings
    )
    assert candidates.candidate_regions[0].geometry_source != "coarse_semantic_search_area"
    assert candidates.candidate_regions[0].eligible_for_auto_export
    assert candidates.candidate_regions[0].review_required
    assert coarse_candidate.rank > candidates.candidate_regions[0].rank
    assert coarse_candidate.features.contains_rooflights
    assert not coarse_candidate.eligible_for_auto_export
    assert coarse_candidate.features.rwp_label_count == 5
    assert coarse_candidate.score < candidates.candidate_regions[0].score

    for candidate in candidates.candidate_regions:
        if candidate.features.overlaps_title_block or candidate.features.overlaps_pv_array:
            assert candidate.rank > candidates.candidate_regions[0].rank
        if candidate.boundary_metrics.included_positive_anchor_ratio < 0.30:
            assert "weak_semantic_scope_alignment" in candidate.quality_warnings


def test_tp17221_source_path_adds_opencv_refined_candidate_before_validation(
    tp17221_pdf: Path,
) -> None:
    vector_document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, MockProvider())
    candidates = generate_candidate_document(
        vector_document,
        source_path=tp17221_pdf,
        refinement_render_dpi=120,
    )
    refined_candidate = next(
        candidate
        for candidate in candidates.candidate_regions
        if candidate.geometry_source == "opencv_refined_vector_candidate"
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
    assert refined_candidate.source_candidate_id == reconstructed_candidate.id
    assert refined_candidate.source_geometry_source == "anchor_boundary_reconstruction"
    assert refined_candidate.rank < coarse_candidate.rank
    assert refined_candidate.eligible_for_auto_export
    assert refined_candidate.review_required
    assert refined_candidate.score > coarse_candidate.score
    assert refined_candidate.area_pdf_units < coarse_candidate.area_pdf_units
    assert refined_candidate.features.rwp_label_count >= 4
    assert refined_candidate.features.rooflight_count >= 5
    assert refined_candidate.features.contains_rooflights
    assert refined_candidate.scores.contains_expected_rooflights == 1.0
    assert refined_candidate.boundary_metrics.internal_constraint_coverage == 1.0
    assert _candidate_iou(refined_candidate.polygon_pdf, TP17221_EXPECTED_VALIDATION_MASK) >= 0.85
    mask_metrics = _candidate_mask_metrics(
        refined_candidate.polygon_pdf,
        tp17221_pdf.parents[0] / "validation" / "TP17221_2501_mask.jpg",
    )
    assert mask_metrics[0] >= 0.629
    assert mask_metrics[1] >= 0.85
    assert mask_metrics[2] >= 0.70
    assert "opencv_refined_candidate_requires_review" in refined_candidate.quality_warnings
    assert "opencv_refined_from_coarse_candidate" not in refined_candidate.quality_warnings
    assert not coarse_candidate.eligible_for_auto_export
    assert coarse_candidate.bbox_pdf[1] > 900


def test_candidates_endpoint_returns_ranked_candidates(
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
        candidates_response = client.get(f"/api/documents/{document_id}/candidates")

    assert upload_response.status_code == 201
    assert candidates_response.status_code == 200
    data = candidates_response.json()
    assert data["document_id"] == document_id
    assert data["summary"]["top_candidate_id"] != "candidate_coarse_semantic_search_01"
    assert data["summary"]["roof_scope_candidate_rank"] == 1
    assert data["candidate_regions"][0]["eligible_for_auto_export"] is True
    assert data["candidate_regions"][-1]["geometry_source"] == "coarse_semantic_search_area"
