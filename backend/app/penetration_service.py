"""Bounded parallel detail scans with durable budgets and ordered reconciliation."""
import asyncio
from dataclasses import dataclass, field
import json
import logging
import time

from .errors import RoiError
from .gemini import response_schema
from .outline_geometry import OutlineCropSource
from .outline_service import bounded_cpu
from .parsing import parse_proposals
from .penetration_geometry import (VectorIndex, annotations_from_proposals, duplicate, plan_crops,
                                   scope_in_crop, validate_scopes)


logger = logging.getLogger("roi_app.penetrations")


@dataclass
class CropScan:
    # The first attempt has already been reserved and committed by the scheduler.
    attempts: int = 1
    candidates: list | None = None
    error: RoiError | None = None
    warnings: list[str] = field(default_factory=list)
    timings_ms: dict = field(default_factory=lambda: dict(provider_queue=0., model=0., geometry=0., reservation_flush=0.))


async def scan_crop(service, session, page, request, base_prompt, scope, prepared, vectors, deadline):
    scan = CropScan()
    crop = prepared.crop
    prompt = (base_prompt + "\nFIRST image is this detailed crop. Accepted ROI boxes above are PAGE context only."
              " The following actual scope geometry is in FIRST-CROP coordinates; points outside 0-1000"
              " describe continuation beyond the crop. Return only complete visible objects: "
              + json.dumps(scope_in_crop(scope, crop), separators=(",", ":")))
    schema = response_schema("penetration", [parent for parent in request.accepted_rois if parent.id == scope.roi_id],
                             service.settings.max_annotations)
    try:
        while True:
            queued = None
            try:
                async with asyncio.timeout_at(deadline):
                    queued = time.monotonic()
                    async with service.provider_slots:
                        scan.timings_ms["provider_queue"] += (time.monotonic() - queued) * 1000
                        queued = None
                        # Initial attempts are committed together; retries remain individually budgeted.
                        if scan.error is not None:
                            if not service.budget_available(session):
                                scan.warnings.append("penetration_call_budget_reached")
                                return scan
                            reserved = time.monotonic()
                            service.reserve_call(session)
                            await service.flush()
                            scan.timings_ms["reservation_flush"] += (time.monotonic() - reserved) * 1000
                            scan.attempts += 1
                            scan.error = None
                        started = time.monotonic()
                        try:
                            async with asyncio.timeout(service.settings.penetration_call_timeout_seconds):
                                with_context = getattr(service.provider, "generate_penetrations_with_context", None)
                                raw = (await with_context(prepared.png, prompt, schema, page.image.png)
                                       if callable(with_context) else await service.provider.generate(prepared.png, prompt, schema))
                        finally:
                            scan.timings_ms["model"] += (time.monotonic() - started) * 1000
                    if raw.finish_reason not in {"STOP", "MAX_TOKENS"}:
                        raise RoiError("provider_refusal", 502)
                    try:
                        proposals = parse_proposals(raw.text, "penetration", {scope.roi_id},
                                                    service.settings.max_response_bytes, service.settings.max_annotations)
                    except RoiError as error:
                        if raw.finish_reason == "MAX_TOKENS" and error.code == "malformed_output":
                            raise RoiError("truncated_output", 502) from None
                        raise
                    started = time.monotonic()
                    try:
                        candidates = await bounded_cpu(annotations_from_proposals, proposals, page, crop,
                                                       scope, vectors, prepared.source)
                    finally:
                        scan.timings_ms["geometry"] += (time.monotonic() - started) * 1000
                    scan.candidates = candidates
                    scan.error = None
                    if raw.finish_reason == "MAX_TOKENS" or len(proposals) == service.settings.max_annotations:
                        scan.warnings.append("possible_truncation")
                    return scan
            except TimeoutError:
                if queued is not None:
                    scan.timings_ms["provider_queue"] += (time.monotonic() - queued) * 1000
                scan.error = RoiError("provider_timeout", 504, True)
            except RoiError as error:
                if error.code == "storage_unavailable":
                    raise
                scan.error = error
            if time.monotonic() >= deadline:
                scan.warnings.append("penetration_scan_time_limit_reached")
                return scan
            if (scan.attempts < service.settings.max_attempts
                    and (scan.error.retryable or scan.error.code == "malformed_output")
                    and not service.budget_available(session)):
                scan.warnings.append("penetration_call_budget_reached")
                return scan
            if not service.retry_allowed(session, scan.error, scan.attempts):
                return scan
            await asyncio.sleep(min(.1 * scan.attempts, max(0., deadline - time.monotonic())))
    finally:
        # bounded_cpu drains cancelled fitting work before these pixels are released.
        if prepared.source is not None:
            prepared.source.gray.close()


async def scan_penetrations(service, session, page, request, base_prompt, settings):
    validate_scopes(request, page.image.width, page.image.height)
    crops, limited = plan_crops(request, page.image.width, page.image.height)
    warnings = ["penetration_crop_limit_reached"] if limited else []
    if {parent.id for parent in request.accepted_rois} - {scope.roi_id for scope in request.scopes}:
        warnings.append("penetration_scope_incomplete")
    annotations, records, failures, attempts = [], [], [], 0
    first_error = None
    started = time.monotonic()
    deadline = started + service.settings.timeout_seconds
    timings = dict(source_decode=0., vector_index=0., crop_preparation=0., reservation_flush=0.,
                   provider_queue=0., model=0., geometry=0., elapsed=0.)
    source = None
    batch = []
    try:
        async with asyncio.timeout_at(deadline):
            phase = time.monotonic()
            source = await bounded_cpu(OutlineCropSource, page.image.original)
            timings["source_decode"] = (time.monotonic() - phase) * 1000
            phase = time.monotonic()
            vectors = await bounded_cpu(VectorIndex, request.vector_segments)
            timings["vector_index"] = (time.monotonic() - phase) * 1000
        # Bounded waves retain crop-order accounting and stop queued work at the object limit.
        concurrency = service.settings.penetration_crop_concurrency
        for offset in range(0, len(crops), concurrency):
            if time.monotonic() >= deadline:
                warnings.append("penetration_scan_time_limit_reached")
                break
            if not service.budget_available(session):
                if attempts == 0:
                    raise RoiError("call_budget_exceeded", 429)
                warnings.append("penetration_call_budget_reached")
                break
            batch = []
            phase = time.monotonic()
            async with asyncio.timeout_at(deadline):
                for scope, box in crops[offset:offset + concurrency]:
                    batch.append((scope, await bounded_cpu(source.prepare, box)))
            timings["crop_preparation"] += (time.monotonic() - phase) * 1000
            phase = time.monotonic()
            count = service.reserve_calls(session, len(batch))
            if count < len(batch):
                warnings.append("penetration_call_budget_reached")
            if count == 0:
                if attempts == 0:
                    raise RoiError("call_budget_exceeded", 429)
                break
            # Even SQLite now commits one initial reservation batch per wave.
            async with asyncio.timeout_at(deadline):
                await service.flush()
            timings["reservation_flush"] += (time.monotonic() - phase) * 1000
            try:
                async with asyncio.TaskGroup() as group:
                    tasks = [group.create_task(scan_crop(service, session, page, request, base_prompt,
                                                          scope, prepared, vectors, deadline))
                             for scope, prepared in batch[:count]]
            except BaseExceptionGroup as errors:
                raise next((error for error in errors.exceptions if isinstance(error, RoiError)),
                           errors.exceptions[0]) from None
            # Completion order never chooses which duplicate or capped annotation wins.
            for index, ((scope, prepared), task) in enumerate(zip(batch[:count], tasks), offset):
                scan = task.result()
                attempts += scan.attempts
                warnings.extend(scan.warnings)
                for name, value in scan.timings_ms.items():
                    timings[name] += value
                if scan.candidates is None:
                    code = scan.error.code if scan.error else "call_budget_exceeded"
                    failures.append({"index": index, "code": code})
                    first_error = first_error or scan.error
                    warnings.append("penetration_crop_failed")
                    continue
                records.append({"roi_id": scope.roi_id, "outline_id": scope.outline_id, **prepared.crop,
                                "attempts": scan.attempts, "timings_ms": scan.timings_ms})
                for candidate in scan.candidates:
                    if not duplicate(candidate, annotations, page.image.width, page.image.height):
                        annotations.append(candidate)
                logger.info("penetration_crop_completed request_id=%s crop=%s attempts=%s model_ms=%.1f geometry_ms=%.1f",
                            request.request_id, index, scan.attempts, scan.timings_ms["model"], scan.timings_ms["geometry"])
            # Release every prepared crop, including crops not scheduled because of budget.
            for _, prepared in batch:
                if prepared.source is not None:
                    prepared.source.gray.close()
            batch = []
            if len(annotations) >= service.settings.max_annotations:
                if len(annotations) > service.settings.max_annotations or offset + count < len(crops):
                    warnings.append("penetration_annotation_limit_reached")
                annotations = annotations[:service.settings.max_annotations]
                break
            if count < min(concurrency, len(crops) - offset):
                break
    except TimeoutError:
        warnings.append("penetration_scan_time_limit_reached")
    finally:
        for _, prepared in batch:
            if prepared.source is not None:
                prepared.source.gray.close()
        if source is not None:
            source.close()
    if not records and first_error is not None:
        raise first_error
    timings["elapsed"] = (time.monotonic() - started) * 1000
    settings.update(crops=records, planned_crops=len(crops), completed_crops=len(records), crop_failures=failures,
                    timings_ms=timings,
                    coverage_complete=len(records) == len(crops) and not limited and "penetration_scope_incomplete" not in warnings)
    status = "partial" if warnings else "complete" if annotations else "no_detections"
    warnings.extend(["penetration_coverage_requires_review", "category_policy_pending_domain_review"])
    return annotations, status, list(dict.fromkeys(warnings)), attempts
