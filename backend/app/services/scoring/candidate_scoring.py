from typing import cast

from app.models.candidates import CandidateScores, PipelineProfile

VECTOR_WEIGHTS: dict[str, float] = {
    "geometric_validity": 0.24,
    "agreement_with_vector_linework": 0.16,
    "contains_expected_rooflights": 0.12,
    "contains_expected_rwp_points": 0.13,
    "proximity_to_tapered_insulation_notes": 0.08,
    "excludes_title_block_legend_pv": 0.04,
    "plausible_area_and_dimensions": 0.04,
    "boundary_evidence_quality": 0.10,
    "semantic_scope_alignment": 0.06,
    "excludes_detected_exclusions": 0.03,
}

RASTER_WEIGHTS: dict[str, float] = {
    "geometric_validity": 0.20,
    "agreement_with_vector_linework": 0.08,
    "contains_expected_rooflights": 0.12,
    "contains_expected_rwp_points": 0.13,
    "proximity_to_tapered_insulation_notes": 0.08,
    "excludes_title_block_legend_pv": 0.08,
    "plausible_area_and_dimensions": 0.12,
    "boundary_evidence_quality": 0.08,
    "semantic_scope_alignment": 0.07,
    "excludes_detected_exclusions": 0.04,
}


def score_candidate(scores: CandidateScores, profile: PipelineProfile = "vector") -> float:
    weights = VECTOR_WEIGHTS if profile == "vector" else RASTER_WEIGHTS
    raw_score = sum(
        cast(float, getattr(scores, field)) * weight for field, weight in weights.items()
    )
    return round(max(0.0, min(1.0, raw_score)), 4)
