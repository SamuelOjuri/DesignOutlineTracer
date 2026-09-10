import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha256
import json
import logging
import time
from typing import Callable
from uuid import uuid4

from .config import Settings
from .errors import OutputDiagnostic, RoiError
from .gemini import PROMPT_VERSIONS, SYSTEM_PROMPT, Provider, make_prompt, response_schema
from .images import PREPARATION_VERSION, PreparedImage
from .models import Annotation, DetectionInput, DetectionResponse, DetectionRun, PageContext
from .parsing import parse_proposals


logger = logging.getLogger("roi_app.detections")


def digest(value: object) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


@dataclass
class CachedProposals:
    annotations: list[Annotation]
    status: str
    warnings: list[str]
    expires: float


@dataclass
class PageRecord:
    context: PageContext
    image: PreparedImage
    expires: float
    upload_id: str = field(default_factory=lambda: f"upload_{uuid4().hex}")
    cache: dict[str, CachedProposals] = field(default_factory=dict)
    follow_ups: int = 0


@dataclass
class Operation:
    fingerprint: str
    key: str
    upload_id: str
    task: asyncio.Task[DetectionResponse] | None


@dataclass
class Session:
    expires: float
    pages: dict[str, PageRecord] = field(default_factory=dict)
    operations: dict[str, Operation] = field(default_factory=dict)
    calls: int = 0


class RoiService:
    def __init__(self, settings: Settings, provider: Provider, clock: Callable[[], float] = time.monotonic):
        self.settings = settings
        self.provider = provider
        self.clock = clock
        self.sessions: dict[str, Session] = {}
        self.active_calls = 0
        self.total_calls = 0
        self.tasks: set[asyncio.Task] = set()

    def remove_page(self, session: Session, page_id: str) -> None:
        page = session.pages.pop(page_id)
        page.cache.clear()
        for operation in session.operations.values():
            if operation.upload_id == page.upload_id and operation.task is not None:
                operation.task.cancel()
                operation.task = None

    def cleanup(self) -> None:
        now = self.clock()
        for owner, session in list(self.sessions.items()):
            for page_id, page in list(session.pages.items()):
                if page.expires <= now or session.expires <= now:
                    self.remove_page(session, page_id)
                else:
                    page.cache = {key: cached for key, cached in page.cache.items() if cached.expires > now}
            if session.expires <= now:
                del self.sessions[owner]

    def upload(self, owner: str, context: PageContext, image: PreparedImage) -> dict:
        self.cleanup()
        if (image.source_hash != context.source_image_hash or image.width != context.source_width
                or image.height != context.source_height):
            raise RoiError("source_identity_mismatch", 409)
        session = self.sessions.get(owner)
        if session is None:
            if len(self.sessions) >= self.settings.max_sessions:
                raise RoiError("session_limit_exceeded", 429)
            session = Session(self.clock() + self.settings.session_ttl_seconds)
            self.sessions[owner] = session
        existing = session.pages.get(context.page_id)
        if existing is not None:
            if existing.context != context:
                raise RoiError("page_identity_conflict", 409)
            return self.receipt(existing)
        if len(session.pages) >= self.settings.max_pages_per_session:
            raise RoiError("page_limit_exceeded", 429)
        stored_bytes = sum(len(page.image.original) + len(page.image.png)
                           for entry in self.sessions.values() for page in entry.pages.values())
        if stored_bytes + len(image.original) + len(image.png) > self.settings.max_storage_bytes:
            raise RoiError("storage_limit_exceeded", 429)
        page = PageRecord(context.model_copy(deep=True), image,
                          min(session.expires, self.clock() + self.settings.page_ttl_seconds))
        session.pages[context.page_id] = page
        return self.receipt(page)

    def receipt(self, page: PageRecord) -> dict:
        return {"page": page.context.model_dump(), "upload_id": page.upload_id,
                "expires_in_seconds": max(0, page.expires - self.clock())}

    def get_page(self, owner: str, page_id: str) -> tuple[Session, PageRecord]:
        self.cleanup()
        session = self.sessions.get(owner)
        if session is None or page_id not in session.pages:
            raise RoiError("page_not_found", 404)
        return session, session.pages[page_id]

    def delete(self, owner: str, page_id: str) -> None:
        session, _page = self.get_page(owner, page_id)
        self.remove_page(session, page_id)

    def inference_settings(self, page: PageRecord) -> dict:
        return {"temperature": 0.5, "max_image_side": 1024, "max_output_tokens": self.settings.max_output_tokens,
                "structured_output": self.settings.structured_output, "thinking_config": None,
                "automatic_function_calling": False, "api_version": "v1beta",
                "max_annotations": self.settings.max_annotations, "preparation_version": PREPARATION_VERSION,
                "inference_image_hash": sha256(page.image.png).hexdigest(),
                "inference_width": page.image.inference_width, "inference_height": page.image.inference_height,
                "max_attempts": self.settings.max_attempts, "timeout_seconds": self.settings.timeout_seconds}

    async def detect(self, owner: str, request: DetectionInput) -> DetectionResponse:
        session, page = self.get_page(owner, request.page_id)
        if request.source_image_hash != page.image.source_hash:
            raise RoiError("source_identity_mismatch", 409)
        data = request.model_dump()
        data["accepted_rois"] = sorted(data["accepted_rois"], key=lambda parent: parent["id"])
        fingerprint = digest(data)
        existing = session.operations.get(request.request_id)
        if existing is not None:
            if existing.fingerprint != fingerprint or existing.upload_id != page.upload_id:
                raise RoiError("request_identity_conflict", 409)
            if existing.task is None:
                raise RoiError("page_not_found", 404)
            return await self.wait_for(existing.task, session, page)
        if len(session.operations) >= self.settings.max_requests_per_session:
            raise RoiError("request_limit_exceeded", 429)
        prompt = make_prompt(request.task, request.accepted_rois, self.settings.max_annotations)
        settings = self.inference_settings(page)
        settings["prompt_hash"] = sha256((SYSTEM_PROMPT + prompt).encode()).hexdigest()
        key = digest({"source_hash": page.image.source_hash, "model": self.settings.model,
                      "prompt_version": PROMPT_VERSIONS[request.task], "schema_version": "1", "task": request.task,
                      "settings": settings, "roi_revision": request.roi_revision,
                      "geometry_revision": request.geometry_revision, "parents": data["accepted_rois"]})
        cached = page.cache.get(key)
        if request.follow_up_of is not None:
            previous = session.operations.get(request.follow_up_of)
            if (previous is None or previous.upload_id != page.upload_id or previous.key != key
                    or previous.task is None or not previous.task.done() or previous.task.cancelled()
                    or previous.task.exception() is not None or previous.task.result().status != "partial"):
                raise RoiError("invalid_follow_up", 409)
            if page.follow_ups >= 1:
                raise RoiError("follow_up_limit_exceeded", 429)
            prompt += "\nReturn additional missed objects only. Previously proposed objects: " + json.dumps([
                {"label": annotation.label, "box_2d": annotation.box_2d, "roi_id": annotation.roi_id}
                for annotation in previous.task.result().annotations
            ], separators=(",", ":"))
            settings["follow_up_of"] = request.follow_up_of
            settings["prompt_hash"] = sha256((SYSTEM_PROMPT + prompt).encode()).hexdigest()
            cached = None
        if cached is None:
            if not self.provider.ready:
                raise RoiError("provider_not_configured", 503)
            if self.active_calls >= self.settings.max_concurrent_requests:
                raise RoiError("concurrency_limit_exceeded", 429)
            if session.calls >= self.settings.max_calls_per_session or self.total_calls >= self.settings.max_total_calls:
                raise RoiError("call_budget_exceeded", 429)
            self.active_calls += 1
        if request.follow_up_of is not None:
            page.follow_ups += 1
        task = asyncio.create_task(self.execute(session, page, request.model_copy(deep=True), key, prompt, settings, cached))
        self.tasks.add(task)

        def release_slot(finished):
            self.tasks.discard(finished)
            if cached is None:
                self.active_calls -= 1
            if not finished.cancelled():
                finished.exception()

        task.add_done_callback(release_slot)
        session.operations[request.request_id] = Operation(fingerprint, key, page.upload_id, task)
        return await self.wait_for(task, session, page)

    async def wait_for(self, task: asyncio.Task, session: Session, page: PageRecord) -> DetectionResponse:
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if session.pages.get(page.context.page_id) is not page:
                raise RoiError("page_not_found", 404) from None
            raise

    async def execute(self, session: Session, page: PageRecord, request: DetectionInput, key: str,
                      prompt: str, settings: dict, cached: CachedProposals | None) -> DetectionResponse:
        started = time.monotonic()
        started_at = datetime.now(timezone.utc).isoformat()
        attempts = 0
        finish_reason = "unavailable"
        response_chars = None
        try:
            result = cached
            if result is None:
                async with asyncio.timeout(self.settings.timeout_seconds):
                    while True:
                        if (session.calls >= self.settings.max_calls_per_session
                                or self.total_calls >= self.settings.max_total_calls):
                            raise RoiError("call_budget_exceeded", 429)
                        session.calls += 1
                        self.total_calls += 1
                        attempts += 1
                        try:
                            raw = await self.provider.generate(page.image.png, prompt, response_schema(
                                request.task, request.accepted_rois, self.settings.max_annotations))
                            finish_reason = raw.finish_reason if raw.finish_reason in {"STOP", "MAX_TOKENS"} else "other"
                            response_chars = len(raw.text)
                            break
                        except RoiError as error:
                            if not error.retryable or attempts >= self.settings.max_attempts:
                                raise
                            await asyncio.sleep(0.1 * attempts)
                    if raw.finish_reason not in {"STOP", "MAX_TOKENS"}:
                        raise RoiError("provider_refusal", 502)
                    try:
                        proposals = parse_proposals(raw.text, request.task,
                                                    {parent.id for parent in request.accepted_rois},
                                                    self.settings.max_response_bytes, self.settings.max_annotations)
                    except RoiError as error:
                        if raw.finish_reason == "MAX_TOKENS" and error.code == "malformed_output":
                            raise RoiError("truncated_output", 502, diagnostic=error.diagnostic) from None
                        raise
                    warnings = []
                    if raw.finish_reason == "MAX_TOKENS" or len(proposals) == self.settings.max_annotations:
                        warnings.append("possible_truncation")
                    if request.follow_up_of is not None:
                        warnings.append("follow_up_requires_reconciliation")
                    status = "partial" if warnings else "complete" if proposals else "no_detections"
                    if request.task != "roof_roi":
                        warnings.append("category_policy_pending_domain_review")
                    annotations = [Annotation(**proposal.model_dump(), id=f"annotation_{uuid4().hex}",
                                              page_id=request.page_id, kind=request.task, proposed_box_2d=proposal.box_2d)
                                   for proposal in proposals]
                    result = CachedProposals(annotations, status, warnings,
                                             min(page.expires, self.clock() + self.settings.cache_ttl_seconds))
                if session.pages.get(request.page_id) is not page or page.expires <= self.clock():
                    raise RoiError("page_not_found", 404)
                if request.follow_up_of is None:
                    page.cache[key] = result
            run = DetectionRun(**{name: getattr(request, name) for name in (
                "page_id", "request_id", "task", "source_image_hash", "roi_revision", "geometry_revision")},
                prompt_version=PROMPT_VERSIONS[request.task], settings=settings,
                started_at=started_at, duration_ms=(time.monotonic() - started) * 1000,
                status=result.status, warnings=result.warnings, cached=cached is not None, provider_attempts=attempts)
            return DetectionResponse(page_id=request.page_id, request_id=request.request_id, task=request.task,
                                     roi_revision=request.roi_revision, status=result.status,
                                     prompt_version=run.prompt_version, warnings=result.warnings,
                                     annotations=[annotation.model_copy(deep=True) for annotation in result.annotations], run=run)
        except TimeoutError:
            raise RoiError("provider_timeout", 504) from None
        except RoiError as error:
            if error.code in {"malformed_output", "truncated_output"}:
                category = error.diagnostic.value if isinstance(error.diagnostic, OutputDiagnostic) else "unspecified"
                logger.warning("roi_output_rejected request_id=%s task=%s code=%s category=%s finish=%s response_chars=%s",
                               request.request_id, request.task, error.code, category, finish_reason, response_chars)
            raise
        except Exception:
            raise RoiError("provider_unavailable", 502) from None

    async def close(self) -> None:
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.sessions.clear()
        await self.provider.close()