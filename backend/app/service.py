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
from .errors import RoiError, output_category
from .gemini import PROMPT_VERSIONS, SYSTEM_PROMPT, Provider, make_prompt, response_schema
from .images import PREPARATION_VERSION, PreparedImage
from .models import Annotation, DetectionInput, DetectionResponse, DetectionRun, PageContext
from .outline_models import CachedOutline, OutlineResponse
from .outlet_models import CachedOutlets, OutletResponse
from .parsing import parse_proposals
from .storage import StateStore
from .supabase_storage import SupabaseStateStore


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
    outline_cache: dict[str, CachedOutline] = field(default_factory=dict)
    outlet_cache: dict[str, CachedOutlets] = field(default_factory=dict)
    follow_ups: int = 0


@dataclass
class Operation:
    fingerprint: str
    key: str
    upload_id: str
    task: asyncio.Task[DetectionResponse | OutlineResponse | OutletResponse] | None
    response: DetectionResponse | OutlineResponse | OutletResponse | None = None
    error: tuple[str, int, bool] | None = None
    interrupted: bool = False


@dataclass
class Session:
    expires: float
    pages: dict[str, PageRecord] = field(default_factory=dict)
    operations: dict[str, Operation] = field(default_factory=dict)
    calls: int = 0


class RoiService:
    def __init__(self, settings: Settings, provider: Provider, clock: Callable[[], float] = time.monotonic,
                 wall_clock: Callable[[], float] = time.time):
        self.settings = settings
        self.provider = provider
        self.clock = clock
        self.wall_clock = wall_clock
        self.sessions: dict[str, Session] = {}
        self.active_calls = 0
        self.total_calls = 0
        self.call_times: list[float] = []
        self.tasks: set[asyncio.Task] = set()
        self._state_version = 0
        self._saved_version = 0
        self._storage_available = True
        self._flush_lock = asyncio.Lock()
        self._store_write_task: asyncio.Task | None = None
        backend = settings.resolved_storage_backend
        self.store = (SupabaseStateStore(settings.database_url.get_secret_value(), settings.supabase_url,
                                        settings.supabase_secret_key.get_secret_value(), settings.storage_bucket,
                                        wall_clock=self.wall_clock)
                      if backend == "supabase" else StateStore(settings.state_path) if backend == "sqlite" else None)
        if self.store:
            try:
                pruned = self.restore()
                self.cleanup()
                if pruned:
                    self.persist()
            except Exception:
                self.store.close()
                raise RuntimeError("ROI persistent state could not be loaded") from None

    @property
    def storage_available(self) -> bool:
        return self._storage_available and (self.store is None or getattr(self.store, "healthy", True))

    def state_snapshot(self) -> tuple[dict, dict[str, tuple[bytes, bytes]]]:
        """Capture only detached JSON values and immutable bytes before yielding to a storage thread."""
        offset = self.wall_clock() - self.clock()
        images = {}
        sessions = {}
        for owner, session in self.sessions.items():
            pages = {}
            for page_id, page in session.pages.items():
                images[page.upload_id] = (page.image.original, page.image.png)
                pages[page_id] = {
                    "context": page.context.model_dump(mode="json"), "expires": page.expires + offset,
                    "upload_id": page.upload_id, "follow_ups": page.follow_ups,
                    "image": {name: getattr(page.image, name) for name in (
                        "source_hash", "width", "height", "inference_width", "inference_height")},
                    "cache": {key: {"annotations": [item.model_dump(mode="json") for item in value.annotations],
                                    "status": value.status, "warnings": list(value.warnings), "expires": value.expires + offset}
                              for key, value in page.cache.items()},
                    "outline_cache": {key: {"response": value.response.model_dump(mode="json"), "expires": value.expires + offset}
                                      for key, value in page.outline_cache.items()},
                    "outlet_cache": {key: {"response": value.response.model_dump(mode="json"), "expires": value.expires + offset}
                                     for key, value in page.outlet_cache.items()},
                }
            operations = {}
            for request_id, operation in session.operations.items():
                response = operation.response
                kind = ("detection" if isinstance(response, DetectionResponse) else "outline"
                        if isinstance(response, OutlineResponse) else "outlet") if response is not None else None
                operations[request_id] = {
                    "fingerprint": operation.fingerprint, "key": operation.key, "upload_id": operation.upload_id,
                    "response_kind": kind, "response": response.model_dump(mode="json") if response is not None else None,
                    "error": operation.error, "interrupted": operation.interrupted or operation.task is not None
                    and response is None and operation.error is None,
                }
            sessions[owner] = {"expires": session.expires + offset, "calls": session.calls,
                               "pages": pages, "operations": operations}
        return {"version": 1, "total_calls": self.total_calls,
                "call_times": [stamp + offset for stamp in self.call_times], "sessions": sessions}, images

    def persist(self) -> None:
        if self.store is None:
            return
        self._state_version += 1
        if getattr(self.store, "deferred", False):
            return
        try:
            self.store.save(*self.state_snapshot())
        except Exception:
            self._storage_available = False
            raise RoiError("storage_unavailable", 503, True) from None
        self._storage_available = True
        self._saved_version = self._state_version

    @staticmethod
    async def drain_storage_task(task: asyncio.Task) -> bool:
        cancelled = False
        while not task.done():
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                cancelled = True
            except Exception:
                break
        return cancelled

    async def flush(self) -> None:
        """Commit remote state without blocking the API event loop or racing another snapshot.

        Cancellation cannot release the lock while a synchronous writer is still
        running: a stale write after a newer reservation would refund a paid call.
        """
        if self.store is None or not getattr(self.store, "deferred", False):
            return
        async with self._flush_lock:
            while self.store is not None and self._saved_version < self._state_version:
                version = self._state_version
                snapshot = self.state_snapshot()
                task = asyncio.create_task(asyncio.to_thread(self.store.save, *snapshot))
                self._store_write_task = task
                try:
                    # Drain even after repeated cancellation; threads cannot be cancelled.
                    cancelled = await self.drain_storage_task(task)
                    if task.cancelled() or task.exception() is not None:
                        self._storage_available = False
                        if not cancelled:
                            raise RoiError("storage_unavailable", 503, True) from None
                    else:
                        self._storage_available = True
                        self._saved_version = version
                    if cancelled:
                        raise asyncio.CancelledError
                finally:
                    self._store_write_task = None

    def restore(self) -> bool:
        payload, images = self.store.load()
        if payload is None:
            return False
        if payload["version"] != 1:
            raise ValueError("unsupported_state_version")
        now = self.wall_clock()
        offset = self.clock() - now
        pruned = False
        self.call_times = [stamp + offset for stamp in payload["call_times"]]
        self.total_calls = len(self.call_times)
        response_types = {"detection": DetectionResponse, "outline": OutlineResponse, "outlet": OutletResponse}
        for owner, stored_session in payload["sessions"].items():
            if stored_session["expires"] <= now:
                pruned = True
                continue
            session = Session(stored_session["expires"] + offset, calls=stored_session["calls"])
            self.sessions[owner] = session
            expired_uploads = set()
            for page_id, stored in stored_session["pages"].items():
                # Retired object bytes may already be gone from remote storage.
                # Check expiry before dereferencing an upload's image manifest.
                if stored["expires"] <= now:
                    pruned = True
                    expired_uploads.add(stored["upload_id"])
                    continue
                original, png = images[stored["upload_id"]]
                page = PageRecord(PageContext.model_validate(stored["context"]), PreparedImage(original, png, **stored["image"]),
                                  stored["expires"] + offset, upload_id=stored["upload_id"], follow_ups=stored["follow_ups"])
                page.cache = {key: CachedProposals([Annotation.model_validate(item) for item in value["annotations"]],
                                                  value["status"], value["warnings"], value["expires"] + offset)
                              for key, value in stored["cache"].items()}
                page.outline_cache = {key: CachedOutline(OutlineResponse.model_validate(value["response"]), value["expires"] + offset)
                                      for key, value in stored["outline_cache"].items()}
                page.outlet_cache = {key: CachedOutlets(OutletResponse.model_validate(value["response"]), value["expires"] + offset)
                                     for key, value in stored["outlet_cache"].items()}
                session.pages[page_id] = page
            for request_id, stored in stored_session["operations"].items():
                if stored["upload_id"] in expired_uploads:
                    # Match remove_page(): keep the identity ledger but retire private results.
                    session.operations[request_id] = Operation(
                        stored["fingerprint"], stored["key"], stored["upload_id"], None)
                    continue
                response = (response_types[stored["response_kind"]].model_validate(stored["response"])
                            if stored["response"] is not None else None)
                session.operations[request_id] = Operation(
                    stored["fingerprint"], stored["key"], stored["upload_id"], None,
                    response=response, error=tuple(stored["error"]) if stored["error"] else None,
                    interrupted=stored["interrupted"],
                )
        return pruned

    def refresh_budget(self) -> bool:
        cutoff = self.clock() - self.settings.call_budget_window_seconds
        self.call_times = [stamp for stamp in self.call_times if stamp > cutoff]
        changed = self.total_calls != len(self.call_times)
        self.total_calls = len(self.call_times)
        return changed

    def budget_available(self, session: Session) -> bool:
        self.refresh_budget()
        return session.calls < self.settings.max_calls_per_session and self.total_calls < self.settings.max_total_calls

    def reserve_call(self, session: Session) -> None:
        if not self.budget_available(session):
            raise RoiError("call_budget_exceeded", 429)
        session.calls += 1
        self.call_times.append(self.clock())
        self.total_calls = len(self.call_times)
        # Commit before sending provider traffic; crashes must not refund paid calls.
        self.persist()

    def completed_response(self, operation: Operation):
        if operation.response is not None:
            return operation.response
        task = operation.task
        if task is not None and task.done() and not task.cancelled() and task.exception() is None:
            return task.result()
        return None

    async def replay_operation(self, operation: Operation, session: Session, page: PageRecord):
        if operation.task is not None:
            return await self.wait_for(operation.task, session, page)
        if operation.response is not None:
            return operation.response.model_copy(deep=True)
        if operation.error is not None:
            raise RoiError(*operation.error)
        if operation.interrupted:
            raise RoiError("request_interrupted", 409)
        raise RoiError("page_not_found", 404)

    def start_operation(self, session: Session, page: PageRecord, request_id: str, fingerprint: str,
                        key: str, execute, uses_slot: bool):
        operation = Operation(fingerprint, key, page.upload_id, None, interrupted=True)
        session.operations[request_id] = operation
        try:
            self.persist()
        except Exception:
            del session.operations[request_id]
            if uses_slot:
                self.active_calls -= 1
            raise

        async def run():
            try:
                response = await execute()
                operation.response = response.model_copy(deep=True)
                operation.interrupted = False
                return response
            except RoiError as error:
                operation.error = (error.code, error.status, error.retryable)
                operation.interrupted = False
                raise
            finally:
                self.persist()
                await self.flush()

        task = asyncio.create_task(run())
        operation.task = task
        self.tasks.add(task)

        def release_slot(finished):
            self.tasks.discard(finished)
            if uses_slot:
                self.active_calls -= 1
            if not finished.cancelled():
                finished.exception()

        task.add_done_callback(release_slot)
        return task

    def remove_page(self, session: Session, page_id: str) -> None:
        page = session.pages.pop(page_id)
        page.cache.clear()
        page.outline_cache.clear()
        page.outlet_cache.clear()
        for operation in session.operations.values():
            if operation.upload_id == page.upload_id:
                if operation.task is not None:
                    operation.task.cancel()
                operation.task = None
                operation.response = None
                operation.error = None
                operation.interrupted = False

    def cleanup(self) -> None:
        now = self.clock()
        changed = self.refresh_budget()
        for owner, session in list(self.sessions.items()):
            for page_id, page in list(session.pages.items()):
                if page.expires <= now or session.expires <= now:
                    self.remove_page(session, page_id)
                    changed = True
                else:
                    count = len(page.cache) + len(page.outline_cache) + len(page.outlet_cache)
                    page.cache = {key: cached for key, cached in page.cache.items() if cached.expires > now}
                    page.outline_cache = {key: cached for key, cached in page.outline_cache.items() if cached.expires > now}
                    page.outlet_cache = {key: cached for key, cached in page.outlet_cache.items() if cached.expires > now}
                    changed |= count != len(page.cache) + len(page.outline_cache) + len(page.outlet_cache)
            if session.expires <= now:
                del self.sessions[owner]
                changed = True
        if changed:
            self.persist()

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
        self.persist()
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
        self.persist()

    def inference_settings(self, page: PageRecord) -> dict:
        return {**self.settings.generation_settings, "max_image_side": 1024,
                "structured_output": self.settings.structured_output,
                "json_mode": self.settings.json_mode,
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
            return await self.replay_operation(existing, session, page)
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
            previous_response = self.completed_response(previous) if previous is not None else None
            if (previous is None or previous.upload_id != page.upload_id or previous.key != key
                    or previous_response is None or previous_response.status != "partial"):
                raise RoiError("invalid_follow_up", 409)
            if page.follow_ups >= 1:
                raise RoiError("follow_up_limit_exceeded", 429)
            prompt += "\nReturn additional missed objects only. Previously proposed objects: " + json.dumps([
                {"label": annotation.label, "box_2d": annotation.box_2d, "roi_id": annotation.roi_id}
                for annotation in previous_response.annotations
            ], separators=(",", ":"))
            settings["follow_up_of"] = request.follow_up_of
            settings["prompt_hash"] = sha256((SYSTEM_PROMPT + prompt).encode()).hexdigest()
            cached = None
        if cached is None:
            if not self.provider.ready:
                raise RoiError("provider_not_configured", 503)
            if self.active_calls >= self.settings.max_concurrent_requests:
                raise RoiError("concurrency_limit_exceeded", 429)
            if not self.budget_available(session):
                raise RoiError("call_budget_exceeded", 429)
            self.active_calls += 1
        if request.follow_up_of is not None:
            page.follow_ups += 1
        task = self.start_operation(session, page, request.request_id, fingerprint, key,
                                    lambda: self.execute(session, page, request.model_copy(deep=True), key, prompt, settings, cached),
                                    cached is None)
        return await self.wait_for(task, session, page)

    async def wait_for(self, task: asyncio.Task, session: Session, page: PageRecord) -> DetectionResponse | OutlineResponse | OutletResponse:
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if session.pages.get(page.context.page_id) is not page:
                raise RoiError("page_not_found", 404) from None
            raise

    def retry_allowed(self, session: Session, error: RoiError, attempts: int) -> bool:
        """Transient provider errors and malformed model output each allow one more bounded attempt."""
        if attempts >= self.settings.max_attempts:
            return False
        if error.retryable:
            return True
        # Malformed output is usually a sampling glitch; never trade it for a budget error.
        return error.code == "malformed_output" and self.budget_available(session)

    async def execute(self, session: Session, page: PageRecord, request: DetectionInput, key: str,
                      prompt: str, settings: dict, cached: CachedProposals | None) -> DetectionResponse:
        started = time.monotonic()
        started_at = datetime.now(timezone.utc).isoformat()
        attempts = 0
        try:
            result = cached
            if result is None:
                async with asyncio.timeout(self.settings.timeout_seconds):
                    while True:
                        self.reserve_call(session)
                        await self.flush()
                        attempts += 1
                        finish_reason, response_chars = "unavailable", None
                        try:
                            raw = await self.provider.generate(page.image.png, prompt, response_schema(
                                request.task, request.accepted_rois, self.settings.max_annotations))
                            finish_reason = raw.finish_reason if raw.finish_reason in {"STOP", "MAX_TOKENS"} else "other"
                            response_chars = len(raw.text)
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
                            break
                        except RoiError as error:
                            if error.code in {"malformed_output", "truncated_output"}:
                                logger.warning("roi_output_rejected request_id=%s task=%s code=%s category=%s finish=%s "
                                               "response_chars=%s attempt=%s", request.request_id, request.task,
                                               error.code, output_category(error), finish_reason, response_chars, attempts)
                            if not self.retry_allowed(session, error, attempts):
                                raise
                            await asyncio.sleep(0.1 * attempts)
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
                model=self.settings.model, prompt_version=PROMPT_VERSIONS[request.task], settings=settings,
                started_at=started_at, duration_ms=(time.monotonic() - started) * 1000,
                status=result.status, warnings=result.warnings, cached=cached is not None, provider_attempts=attempts)
            return DetectionResponse(page_id=request.page_id, request_id=request.request_id, task=request.task,
                                     model=self.settings.model, roi_revision=request.roi_revision, status=result.status,
                                     prompt_version=run.prompt_version, warnings=result.warnings,
                                     annotations=[annotation.model_copy(deep=True) for annotation in result.annotations], run=run)
        except TimeoutError:
            raise RoiError("provider_timeout", 504) from None
        except RoiError:
            raise
        except Exception:
            raise RoiError("provider_unavailable", 502) from None

    async def close(self) -> None:
        tasks = list(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        try:
            self.persist()
            await self.flush()
        finally:
            try:
                async with self._flush_lock:
                    if self.store is not None:
                        store, self.store = self.store, None
                        if getattr(store, "deferred", False):
                            closing = asyncio.create_task(asyncio.to_thread(store.close))
                            cancelled = await self.drain_storage_task(closing)
                            if cancelled:
                                raise asyncio.CancelledError
                            if closing.cancelled() or closing.exception() is not None:
                                raise RoiError("storage_unavailable", 503, True) from None
                        else:
                            store.close()
            finally:
                self.sessions.clear()
                await self.provider.close()
