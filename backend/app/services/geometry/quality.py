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
    if production_schema.target_area.review_required and checks.human_review_status != "approved":
        failures.append("human_review_required")

    if production_schema.document.source_type == "vector_pdf":
        if not checks.contains_or_borders_rwp:
            failures.append("missing_rwp_constraints")
        is_tp17221 = production_schema.document.source_file.startswith("TP17221")
        if len(production_schema.constraints.rainwater_outlets) < 5 and is_tp17221:
            failures.append("expected_rwp_count_below_5")

    if failures:
        raise QualityGateError("DXF export quality gates failed: " + ", ".join(failures))
