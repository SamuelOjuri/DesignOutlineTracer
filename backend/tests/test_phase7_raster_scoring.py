from app.models.candidates import CandidateScores
from app.services.scoring.candidate_scoring import score_candidate


def test_raster_scoring_profile_weights_semantic_and_review_evidence() -> None:
    scores = CandidateScores(
        geometric_validity=1,
        agreement_with_vector_linework=0.2,
        contains_expected_rooflights=1,
        contains_expected_rwp_points=0.8,
        proximity_to_tapered_insulation_notes=1,
        excludes_title_block_legend_pv=1,
        plausible_area_and_dimensions=1,
    )

    assert score_candidate(scores, "raster") > 0.75
