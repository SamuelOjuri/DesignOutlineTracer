from dataclasses import dataclass

from app.models.candidates import CandidateDocument, CandidateRegion, CandidateSafetyStatus

BLOCKING_QUALITY_WARNINGS = {
    "candidate_area_too_broad",
    "invalid_geometry",
    "overlaps_pv_array",
    "overlaps_title_block",
}

REVIEW_QUALITY_WARNINGS = {
    "anchor_boundary_reconstruction_requires_review",
    "candidate_area_outlier",
    "coarse_candidate_requires_review",
    "low_boundary_linework_agreement",
    "missing_rwp_anchor",
    "not_cad_final_geometry",
    "synthetic_gap_bridges_used",
}

VALIDATION_CONFIDENCE_CAP = 0.62
BLOCKED_CONFIDENCE_CAP = 0.55


@dataclass(frozen=True)
class CandidateSelection:
    candidate: CandidateRegion
    requested_candidate: CandidateRegion | None
    demoted: bool
    warnings: list[str]


def safety_status_for_candidate(candidate: CandidateRegion) -> CandidateSafetyStatus:
    if _blocking_reasons(candidate):
        return "blocked"
    if candidate.review_required or candidate.score < 0.75 or candidate.quality_warnings:
        return "review"
    return "pass"


def safety_warnings_for_candidate(candidate: CandidateRegion) -> list[str]:
    warnings: list[str] = []
    quality_warnings = set(candidate.quality_warnings)
    if candidate.geometry_source == "coarse_semantic_search_area":
        warnings.append("coarse_candidate_not_final_geometry")
    if quality_warnings & BLOCKING_QUALITY_WARNINGS:
        warnings.extend(sorted(quality_warnings & BLOCKING_QUALITY_WARNINGS))
    if candidate.scores.agreement_with_vector_linework < 0.45:
        warnings.append("boundary_linework_agreement_below_gate")
    if candidate.features.overlaps_title_block:
        warnings.append("candidate_overlaps_title_block")
    if candidate.features.overlaps_pv_array:
        warnings.append("candidate_overlaps_pv_array")
    if not candidate.features.geometry_valid:
        warnings.append("candidate_geometry_invalid")
    return sorted(set(warnings))


def select_candidate_for_validation(
    candidate_document: CandidateDocument,
    selected_candidate_id: str,
) -> CandidateSelection:
    requested = next(
        (
            candidate
            for candidate in candidate_document.candidate_regions
            if candidate.id == selected_candidate_id
        ),
        None,
    )
    if (
        requested is not None
        and requested.safety_status != "blocked"
        and requested.eligible_for_review_selection
    ):
        return CandidateSelection(
            candidate=requested,
            requested_candidate=requested,
            demoted=False,
            warnings=[],
        )

    replacement = next(
        (
            candidate
            for candidate in candidate_document.candidate_regions
            if candidate.safety_status != "blocked"
            and candidate.eligible_for_review_selection
            and candidate.geometry_source != "coarse_semantic_search_area"
        ),
        None,
    )
    if replacement is None:
        replacement = next(
            (
                candidate
                for candidate in candidate_document.candidate_regions
                if candidate.geometry_source != "coarse_semantic_search_area"
                and candidate.eligible_for_review_selection
            ),
            candidate_document.candidate_regions[0],
        )
    warnings = ["selected_candidate_failed_safety_gate"]
    if requested is not None:
        warnings.extend(requested.safety_warnings)
    else:
        warnings.append("selected_candidate_id_not_found")
    if replacement.id != selected_candidate_id:
        warnings.append(f"demoted_to:{replacement.id}")
    return CandidateSelection(
        candidate=replacement,
        requested_candidate=requested,
        demoted=replacement.id != selected_candidate_id,
        warnings=sorted(set(warnings)),
    )


def cap_confidence_for_safety(
    confidence: float,
    *,
    candidate: CandidateRegion,
    demoted: bool,
) -> float:
    cap = 1.0
    if candidate.safety_status == "blocked":
        cap = min(cap, BLOCKED_CONFIDENCE_CAP)
    if demoted or candidate.safety_warnings or candidate.quality_warnings:
        cap = min(cap, VALIDATION_CONFIDENCE_CAP)
    return round(max(0.0, min(confidence, cap)), 4)


def _blocking_reasons(candidate: CandidateRegion) -> list[str]:
    reasons = list(set(candidate.quality_warnings) & BLOCKING_QUALITY_WARNINGS)
    if candidate.geometry_source == "coarse_semantic_search_area":
        reasons.append("coarse_candidate_not_final_geometry")
    if candidate.scores.agreement_with_vector_linework < 0.45:
        reasons.append("boundary_linework_agreement_below_gate")
    if candidate.features.overlaps_title_block:
        reasons.append("candidate_overlaps_title_block")
    if candidate.features.overlaps_pv_array:
        reasons.append("candidate_overlaps_pv_array")
    if not candidate.features.geometry_valid:
        reasons.append("candidate_geometry_invalid")
    return reasons