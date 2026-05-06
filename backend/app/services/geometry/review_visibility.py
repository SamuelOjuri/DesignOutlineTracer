from app.models.candidates import CandidateRegion


def is_review_visible_candidate(candidate: CandidateRegion) -> bool:
    if candidate.geometry_source != "anchor_boundary_reconstruction":
        return False
    return bool(
        candidate.features.rwp_label_count >= 2
        or "synthetic_gap_bridges_used" in candidate.quality_warnings
        or "candidate_area_outlier" in candidate.quality_warnings
        or candidate.geometry_confidence >= 0.72
    )