"""Scope-aware penetration detail scans; every provider attempt is budgeted."""
import asyncio
import json
import time
from uuid import uuid4

from .errors import RoiError
from .gemini import response_schema
from .outline_geometry import prepare_outline_crop
from .outline_service import bounded_cpu
from .parsing import parse_proposals
from .penetration_geometry import (annotation_from_proposal, duplicate, plan_crops, scope_in_crop,
                                   validate_scopes)


async def scan_penetrations(service, session, page, request, base_prompt, settings):
    validate_scopes(request, page.image.width, page.image.height)
    crops, limited = plan_crops(request, page.image.width, page.image.height)
    warnings = ["penetration_crop_limit_reached"] if limited else []
    if {parent.id for parent in request.accepted_rois} - {scope.roi_id for scope in request.scopes}:
        warnings.append("penetration_scope_incomplete")
    annotations, records, attempts, successful = [], [], 0, 0
    deadline = time.monotonic() + service.settings.timeout_seconds
    for index, (scope, crop_box) in enumerate(crops):
        if not service.budget_available(session):
            if attempts == 0:
                raise RoiError("call_budget_exceeded", 429)
            warnings.append("penetration_call_budget_reached")
            break
        if time.monotonic() >= deadline:
            warnings.append("penetration_scan_time_limit_reached")
            break
        prepared = await bounded_cpu(prepare_outline_crop, page.image.original, crop_box)
        crop = prepared.crop
        parents = [parent for parent in request.accepted_rois if parent.id == scope.roi_id]
        # Crop coordinates supersede the accepted parents' normalized page boxes.
        prompt = (base_prompt + "\nFIRST image is this detailed crop. Accepted ROI boxes above are PAGE context only."
                  " The following actual scope geometry is in FIRST-CROP coordinates; points outside 0-1000"
                  " describe continuation beyond the crop. Return only complete visible objects: "
                  + json.dumps(scope_in_crop(scope, crop), separators=(",", ":")))
        schema = response_schema("penetration", parents, service.settings.max_annotations)
        crop_attempts = 0
        while True:
            if time.monotonic() >= deadline:
                warnings.append("penetration_scan_time_limit_reached")
                break
            if not service.budget_available(session):
                warnings.append("penetration_call_budget_reached")
                break
            service.reserve_call(session)
            await service.flush()
            attempts += 1
            crop_attempts += 1
            try:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    warnings.append("penetration_scan_time_limit_reached")
                    break
                async with asyncio.timeout(min(remaining, service.settings.outlet_call_timeout_seconds)):
                    with_context = getattr(service.provider, "generate_penetrations_with_context", None)
                    raw = (await with_context(prepared.png, prompt, schema, page.image.png) if with_context
                           else await service.provider.generate(prepared.png, prompt, schema))
                if raw.finish_reason not in {"STOP", "MAX_TOKENS"}:
                    raise RoiError("provider_refusal", 502)
                try:
                    proposals = parse_proposals(raw.text, "penetration", {scope.roi_id},
                                                service.settings.max_response_bytes, service.settings.max_annotations)
                except RoiError as error:
                    if raw.finish_reason == "MAX_TOKENS" and error.code == "malformed_output":
                        raise RoiError("truncated_output", 502) from None
                    raise
                successful += 1
                records.append({"roi_id": scope.roi_id, "outline_id": scope.outline_id, **crop})
                if raw.finish_reason == "MAX_TOKENS" or len(proposals) == service.settings.max_annotations:
                    warnings.append("possible_truncation")
                for proposal in proposals:
                    candidate = await bounded_cpu(annotation_from_proposal, proposal, page,
                        f"annotation_{uuid4().hex}", crop, scope, request.vector_segments, prepared.source)
                    if candidate is None:
                        continue
                    if not duplicate(candidate, annotations, page.image.width, page.image.height):
                        annotations.append(candidate)
                break
            except TimeoutError:
                error = RoiError("provider_timeout", 504, True)
                if not service.retry_allowed(session, error, crop_attempts) or time.monotonic() >= deadline:
                    if not successful:
                        raise error from None
                    warnings.append("penetration_crop_failed")
                    break
            except RoiError as error:
                if not service.retry_allowed(session, error, crop_attempts):
                    if not successful:
                        raise
                    warnings.append("penetration_crop_failed")
                    break
            await asyncio.sleep(.1 * crop_attempts)
        if len(annotations) >= service.settings.max_annotations:
            if len(annotations) > service.settings.max_annotations or index + 1 < len(crops):
                warnings.append("penetration_annotation_limit_reached")
            annotations = annotations[:service.settings.max_annotations]
            break
    settings["crops"] = records
    settings["coverage_complete"] = len(records) == len(crops) and not limited and "penetration_scope_incomplete" not in warnings
    # An independent coverage caveat remains visible even when all planned tiles completed.
    # It does not label every successful scan partial or disable ordinary cache replay.
    status = "partial" if warnings else "complete" if annotations else "no_detections"
    warnings.extend(["penetration_coverage_requires_review", "category_policy_pending_domain_review"])
    return annotations, status, list(dict.fromkeys(warnings)), attempts
