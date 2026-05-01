from typing import cast

from app.models.candidates import CandidateScores, PipelineProfile

VECTOR_WEIGHTS: dict[str, float] = {
    "geometric_validity": 0.30,
    "agreement_with_vector_linework": 0.20,
    "contains_expected_rooflights": 0.15,
    "contains_expected_rwp_points": 0.15,
    "proximity_to_tapered_insulation_notes": 0.10,
    "excludes_title_block_legend_pv": 0.05,
    "plausible_area_and_dimensions": 0.05,
}

RASTER_WEIGHTS: dict[str, float] = {
    "geometric_validity": 0.25,
    "agreement_with_vector_linework": 0.10,
    "contains_expected_rooflights": 0.15,
    "contains_expected_rwp_points": 0.15,
    "proximity_to_tapered_insulation_notes": 0.10,
    "excludes_title_block_legend_pv": 0.10,
    "plausible_area_and_dimensions": 0.15,
}


def score_candidate(scores: CandidateScores, profile: PipelineProfile = "vector") -> float:
    weights = VECTOR_WEIGHTS if profile == "vector" else RASTER_WEIGHTS
    raw_score = sum(
        cast(float, getattr(scores, field)) * weight for field, weight in weights.items()
    )
    return round(max(0.0, min(1.0, raw_score)), 4)
