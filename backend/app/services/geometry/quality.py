from collections.abc import Sequence

from app.models.production import ProductionSchema


class QualityGateError(RuntimeError):
    pass


def enforce_export_quality_gates(
    *,
    production_schema: ProductionSchema,
    requested_formats: Sequence[str],
) -> None:
    if "dxf" not in requested_formats:
        return

    checks = production_schema.quality_checks
    failures: list[str] = []
    if not checks.polygon_closed:
        failures.append("polygon_not_closed")
    if checks.self_intersections:
        failures.append("self_intersections")
    if not checks.excludes_title_block:
        failures.append("title_block_not_excluded")
    if not checks.excludes_legend:
        failures.append("legend_not_excluded")
    if not checks.scale_calibrated:
        failures.append("scale_not_calibrated")
    if not checks.cad_candidate_exportable:
        failures.append("candidate_not_cad_exportable")
    if checks.calibration_confidence < 0.85 and checks.human_review_status != "approved":
        failures.append("scale_requires_confirmation")
    if checks.outlet_geometry_confidence < 0.7 and checks.human_review_status != "approved":
        failures.append("outlet_geometry_requires_review")
    if production_schema.target_area.review_required and checks.human_review_status != "approved":
        failures.append("human_review_required")

    if production_schema.document.source_type == "vector_pdf":
        if not checks.contains_or_borders_rwp:
            failures.append("missing_rwp_constraints")
        if not production_schema.constraints.rainwater_outlets:
            failures.append("missing_rwp_outlets")

    if failures:
        raise QualityGateError("DXF export quality gates failed: " + ", ".join(failures))
