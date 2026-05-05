from pathlib import Path

from shapely.geometry import Polygon

from app.services.ai.mock import MockProvider
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.opencv_refinement import refine_candidate_with_opencv
from app.services.vector_pipeline.extractor import extract_vector_document


def test_tp17221_opencv_refinement_reduces_non_target_scope(tp17221_pdf: Path) -> None:
    provider = MockProvider()
    vector_document = extract_vector_document(tp17221_pdf, tp17221_pdf.stem, provider)
    candidate_document = generate_candidate_document(vector_document)
    candidate = candidate_document.candidate_regions[0]

    result = refine_candidate_with_opencv(
        source_path=tp17221_pdf,
        vector_document=vector_document,
        candidate=candidate,
        semantic_zones=candidate_document.semantic_zones,
        render_dpi=120,
    )
    refined_polygon = Polygon(result.polygon_pdf)

    assert result.accepted
    assert result.geometry_source == "opencv_refined_vector_candidate"
    assert refined_polygon.is_valid
    assert refined_polygon.area < candidate.area_pdf_units
    assert result.metrics.excluded_region_removed_area_ratio > 0.05
    assert result.metrics.semantic_anchor_retention >= 0.8
    assert result.metrics.boundary_support_ratio >= 0.35
    assert "opencv_exclusion_subtraction_requires_review" in result.warnings