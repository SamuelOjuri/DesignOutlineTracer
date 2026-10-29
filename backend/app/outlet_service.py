"""Rainwater inlet proposals, sharing the ROI ownership, limits and call ledger."""
import asyncio
from hashlib import sha256
import json
from pathlib import Path
import re
import time
from uuid import uuid4

from pydantic import ValidationError

from .errors import RoiError
from .gemini import OUTLET_SYSTEM_PROMPT
from .outlet_geometry import (ALGORITHM_VERSION, MAX_CROPS, duplicate_anchor, page_box, plan_crops,
                              scope_in_crop, scope_location, source_anchor, validate_scopes)
from .outlet_models import CachedOutlets, ModelOutlet, OutletAnnotation, OutletInput, OutletResponse
from .outline_geometry import prepare_outline_crop
from .outline_service import bounded_cpu
from .parsing import reject_constant, unique_object
from .service import Operation, PageRecord, RoiService, Session, digest


PROMPT_VERSION = "rainwater-outlet-v1"
OUTLET_PROMPT = (Path(__file__).parent / "prompts" / f"{PROMPT_VERSION}.txt").read_text(encoding="utf-8")


def model_schema(maximum: int):
    coordinate = {"type": "number", "minimum": 0, "maximum": 1000}
    properties = {
        "label": {"type": "string"},
        "subtype": {"type": "string", "enum": ["internal_outlet", "parapet_outlet", "scupper"]},
        "box_2d": {"type": "array", "items": coordinate, "minItems": 4, "maxItems": 4},
        "anchor": {"type": "object", "properties": {"x": coordinate, "y": coordinate},
                   "required": ["x", "y"], "additionalProperties": False},
        "evidence": {"type": "string"},
    }
    return {"type": "array", "maxItems": maximum, "items": {
        "type": "object", "properties": properties, "required": list(properties), "additionalProperties": False,
    }}


def parse_outlets(text: str, maximum_bytes: int, maximum_objects: int):
    if len(text.encode("utf-8")) > maximum_bytes:
        raise RoiError("response_too_large", 502)
    payload = text.strip()
    fence = re.fullmatch(r"```(?:json)?[ \t]*\r?\n(.*?)\r?\n```", payload, re.IGNORECASE | re.DOTALL)
    if fence:
        payload = fence.group(1)
    try:
        raw = json.loads(payload, object_pairs_hook=unique_object, parse_constant=reject_constant)
        if not isinstance(raw, list) or len(raw) > maximum_objects:
            raise ValueError("invalid_outlet_list")
        return [ModelOutlet.model_validate(item) for item in raw]
    except (ValueError, TypeError, RecursionError, ValidationError):
        raise RoiError("malformed_output", 502) from None


class OutletService:
    def __init__(self, service: RoiService):
        self.service = service

    async def generate(self, owner: str, request: OutletInput) -> OutletResponse:
        service = self.service
        session, page = service.get_page(owner, request.page_id)
        if request.source_image_hash != page.image.source_hash:
            raise RoiError("source_identity_mismatch", 409)
        validate_scopes(request, page.image.width, page.image.height)
        data = request.model_dump(mode="json")
        fingerprint = digest(data)
        existing = session.operations.get(request.request_id)
        if existing is not None:
            if existing.fingerprint != fingerprint or existing.upload_id != page.upload_id:
                raise RoiError("request_identity_conflict", 409)
            if existing.task is None:
                raise RoiError("page_not_found", 404)
            return await service.wait_for(existing.task, session, page)
        if len(session.operations) >= service.settings.max_requests_per_session:
            raise RoiError("request_limit_exceeded", 429)
        settings = {
            **service.settings.generation_settings,
            "structured_output": service.settings.structured_output,
            "automatic_function_calling": False, "api_version": "v1beta",
            "max_image_side": 2048, "crop_padding_fraction": .06, "max_crops": MAX_CROPS,
            "max_attempts": service.settings.max_attempts,
            "max_annotations": service.settings.max_annotations,
            "timeout_seconds": service.settings.timeout_seconds,
            "scope_geometry_hash": digest(data["scopes"]),
            "system_prompt_version": "outlet-system-v1",
            "prompt_hash": sha256((OUTLET_SYSTEM_PROMPT + OUTLET_PROMPT).encode()).hexdigest(),
            "overview_supplied": callable(getattr(service.provider, "generate_outlets_with_context", None)),
        }
        key = digest({"task": "outlets", "source_hash": request.source_image_hash,
                      "model": service.settings.model, "contract_version": "outlet-1",
                      "algorithm_version": ALGORITHM_VERSION, "prompt_version": PROMPT_VERSION,
                      "settings": settings, "parents": data["accepted_rois"], "scopes": data["scopes"],
                      "scope_signature": request.scope_signature, "roi_revision": request.roi_revision,
                      "geometry_revision": request.geometry_revision})
        cached = page.outlet_cache.get(key)
        if cached is None:
            if not service.provider.ready:
                raise RoiError("provider_not_configured", 503)
            if service.active_calls >= service.settings.max_concurrent_requests:
                raise RoiError("concurrency_limit_exceeded", 429)
            if session.calls >= service.settings.max_calls_per_session or service.total_calls >= service.settings.max_total_calls:
                raise RoiError("call_budget_exceeded", 429)
            service.active_calls += 1
        task = asyncio.create_task(self.execute(session, page, request.model_copy(deep=True), key, settings, cached))
        service.tasks.add(task)

        def release_slot(finished):
            service.tasks.discard(finished)
            if cached is None:
                service.active_calls -= 1
            if not finished.cancelled():
                finished.exception()

        task.add_done_callback(release_slot)
        session.operations[request.request_id] = Operation(fingerprint, key, page.upload_id, task)
        return await service.wait_for(task, session, page)

    async def execute(self, session: Session, page: PageRecord, request: OutletInput, key: str,
                      settings: dict, cached: CachedOutlets | None):
        service = self.service
        started = time.monotonic()
        attempts = 0
        try:
            if cached is not None:
                response = cached.response.model_copy(deep=True)
                response.request_id = request.request_id
                response.run.update(cached=True, provider_attempts=0, duration_ms=(time.monotonic() - started) * 1000)
                return response
            annotations, warnings, crop_records = [], [], []
            completed = 0
            async with asyncio.timeout(service.settings.timeout_seconds):
                crops, limited = plan_crops(request, page.image.width, page.image.height)
                if limited:
                    warnings.append("outlet_crop_limit_reached")
                for scope, crop_box in crops:
                    if session.calls >= service.settings.max_calls_per_session or service.total_calls >= service.settings.max_total_calls:
                        if not completed:
                            raise RoiError("call_budget_exceeded", 429)
                        warnings.append("outlet_call_budget_reached")
                        break
                    prepared = await bounded_cpu(prepare_outline_crop, page.image.original, crop_box)
                    crop = prepared.crop
                    prompt = (OUTLET_PROMPT + f"\nReturn at most {service.settings.max_annotations} objects."
                              + "\nScope geometry in normalized FIRST-CROP coordinates; vertices outside 0-1000"
                              " describe continuation beyond the crop, but return only visible symbols: "
                              + json.dumps(scope_in_crop(scope, crop), separators=(",", ":")))
                    crop_attempts = 0
                    raw = None
                    while True:
                        if session.calls >= service.settings.max_calls_per_session or service.total_calls >= service.settings.max_total_calls:
                            if completed:
                                warnings.append("outlet_call_budget_reached")
                                break
                            raise RoiError("call_budget_exceeded", 429)
                        session.calls += 1
                        service.total_calls += 1
                        attempts += 1
                        crop_attempts += 1
                        try:
                            with_context = getattr(service.provider, "generate_outlets_with_context", None)
                            if callable(with_context):
                                raw = await with_context(prepared.png, prompt, model_schema(service.settings.max_annotations), page.image.png)
                            else:
                                raw = await service.provider.generate(prepared.png, prompt, model_schema(service.settings.max_annotations))
                            break
                        except RoiError as error:
                            if not error.retryable or crop_attempts >= service.settings.max_attempts:
                                raise
                            await asyncio.sleep(.1 * crop_attempts)
                    if raw is None:
                        break
                    if raw.finish_reason not in {"STOP", "MAX_TOKENS"}:
                        raise RoiError("provider_refusal", 502)
                    try:
                        proposals = parse_outlets(raw.text, service.settings.max_response_bytes, service.settings.max_annotations)
                    except RoiError as error:
                        if raw.finish_reason == "MAX_TOKENS" and error.code == "malformed_output":
                            raise RoiError("truncated_output", 502) from None
                        raise
                    completed += 1
                    crop_records.append({"roi_id": scope.roi_id, "outline_id": scope.outline_id, **crop})
                    if raw.finish_reason == "MAX_TOKENS" or len(proposals) == service.settings.max_annotations:
                        warnings.append("possible_truncation")
                    for proposal in proposals:
                        anchor = source_anchor(proposal.anchor, crop)
                        box = page_box(proposal.box_2d, crop, page.image.width, page.image.height)
                        candidate = OutletAnnotation(id=f"outlet_{uuid4().hex}", page_id=request.page_id,
                                                     label=proposal.label, subtype=proposal.subtype,
                                                     box_2d=box, proposed_box_2d=box,
                                                     anchor=anchor, proposed_anchor=anchor,
                                                     roi_id=scope.roi_id, outline_id=scope.outline_id,
                                                     evidence=proposal.evidence)
                        location = scope_location(candidate.anchor, scope)
                        if location != "inside":
                            candidate.validity = "needs_review"
                            candidate.warnings = ["outlet_in_opening" if location == "opening" else "outlet_outside_scope"]
                        if not duplicate_anchor(candidate, annotations, page.image.width, page.image.height):
                            annotations.append(candidate)
                    if len(annotations) >= service.settings.max_annotations:
                        excess = len(annotations) > service.settings.max_annotations
                        annotations = annotations[:service.settings.max_annotations]
                        if excess or completed < len(crops):
                            warnings.append("outlet_annotation_limit_reached")
                        break
            if session.pages.get(request.page_id) is not page or page.expires <= service.clock():
                raise RoiError("page_not_found", 404)
            response = OutletResponse(
                page_id=request.page_id, request_id=request.request_id, source_image_hash=request.source_image_hash,
                scope_signature=request.scope_signature,
                status="partial" if warnings else "complete" if annotations else "no_detections",
                annotations=annotations, warnings=list(dict.fromkeys(warnings)),
                model=service.settings.model, prompt_version=PROMPT_VERSION,
                run={"duration_ms": (time.monotonic() - started) * 1000, "cached": False,
                     "provider_attempts": attempts, "algorithm_version": ALGORITHM_VERSION,
                     "settings": settings, "crops": crop_records},
            )
            # Incomplete scans must be eligible for a new run after a budget or
            # scope change; request-ID idempotency still retains this response.
            if response.status != "partial":
                page.outlet_cache[key] = CachedOutlets(response.model_copy(deep=True),
                                                      min(page.expires, service.clock() + service.settings.cache_ttl_seconds))
            return response
        except TimeoutError:
            raise RoiError("provider_timeout", 504) from None
        except RoiError:
            raise
        except Exception:
            raise RoiError("outlet_detection_failed", 502) from None
