import asyncio
from contextlib import asynccontextmanager
from hashlib import sha256
import json
import logging
import re
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from pydantic import ValidationError
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.responses import JSONResponse, Response

from .config import Settings
from .errors import RoiError
from .gemini import GeminiProvider, Provider
from .images import prepare_image
from .models import DetectionInput, PageContext
from .outline_models import OutlineInput
from .outline_service import OutlineService
from .outlet_models import OutletInput
from .outlet_service import OutletService
from .parsing import reject_constant, unique_object
from .service import RoiService
from .supabase_storage import SupabaseWriterBusy


PREFIX = "/api/roi/v1"
logger = logging.getLogger("roi_app.storage")
STORAGE_ACTIVATION_TIMEOUT_SECONDS = 300
STORAGE_ACTIVATION_RETRY_SECONDS = 1


def error_response(error: RoiError) -> JSONResponse:
    headers = {"Cache-Control": "no-store"}
    if error.status == 503 and error.code in {"storage_unavailable", "storage_starting"}:
        headers["Retry-After"] = "2"
    return JSONResponse({"error": {"code": error.code, "retryable": error.retryable}}, status_code=error.status,
                        headers=headers)


def owner_from_headers(headers) -> str:
    authorization = headers.get("authorization", "")
    if not re.fullmatch(r"Bearer [a-f0-9]{64}", authorization):
        raise RoiError("session_token_required", 401)
    return sha256(authorization[7:].encode()).hexdigest()


class BoundedRequests:
    def __init__(self, app, settings: Settings, available=None):
        self.app = app
        self.settings = settings
        self.active = 0
        self.available = available

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.decode("latin1"): value.decode("latin1") for key, value in scope["headers"]}
        is_health = scope["method"] == "GET" and scope["path"] in {PREFIX + "/health", "/healthz"}
        try:
            if (self.settings.deployment_mode == "localhost_only"
                    and (not scope.get("client") or scope["client"][0] not in {"127.0.0.1", "::1"})):
                raise RoiError("localhost_only", 403)
            if headers.get("origin") is not None and headers["origin"] not in self.settings.allowed_origins:
                raise RoiError("origin_not_allowed", 403)
            if not is_health and self.active >= self.settings.max_http_requests:
                raise RoiError("http_concurrency_limit_exceeded", 429)
            if scope["method"] in {"POST", "DELETE"}:
                owner_from_headers(headers)
            if not is_health and self.available is not None and not self.available():
                raise RoiError("storage_unavailable", 503, retryable=True)
        except RoiError as error:
            return await error_response(error)(scope, receive, send)
        # A busy detection service must remain healthy for Render's readiness checks.
        if is_health:
            return await self.app(scope, receive, send)
        self.active += 1
        try:
            bounded_receive = receive
            if scope["method"] == "POST":
                maximum = (self.settings.max_upload_bytes + 16384 if scope["path"] == PREFIX + "/pages"
                           else 512 * 1024 if re.fullmatch(PREFIX + r"/pages/[a-zA-Z0-9_-]+/(outlines|outlets)", scope["path"])
                           else 65536)
                try:
                    if int(headers.get("content-length", "0")) > maximum:
                        raise RoiError("request_too_large", 413)
                except ValueError:
                    raise RoiError("invalid_request", 400) from None
                body = bytearray()
                async with asyncio.timeout(self.settings.upload_timeout_seconds):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        chunk = message.get("body", b"")
                        if len(body) + len(chunk) > maximum:
                            raise RoiError("request_too_large", 413)
                        body.extend(chunk)
                        if not message.get("more_body", False):
                            break
                delivered = False

                async def bounded_receive():
                    nonlocal delivered
                    if delivered:
                        return await receive()
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}

            await self.app(scope, bounded_receive, send)
        except RoiError as error:
            await error_response(error)(scope, receive, send)
        except TimeoutError:
            await error_response(RoiError("upload_timeout", 408))(scope, receive, send)
        finally:
            self.active -= 1


def decode_json(text: str):
    try:
        return json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant)
    except (ValueError, RecursionError):
        raise RoiError("invalid_request") from None


def create_app(settings: Settings | None = None, provider: Provider | None = None, clock=time.monotonic) -> FastAPI:
    settings = settings or Settings.from_env()
    provider = provider or GeminiProvider(settings)
    try:
        service = RoiService(settings, provider, clock)
    except SupabaseWriterBusy:
        # Only a validated database/schema/private-bucket preflight can enter
        # standby. Render retires the old writer after this process is live.
        service = None
    outlines = OutlineService(service) if service is not None else None
    outlets = OutletService(service) if service is not None else None
    startup_failed = False
    image_slots = asyncio.Semaphore(settings.max_image_preparations)

    async def close_candidate(candidate):
        try:
            await candidate.close()
        except Exception:
            # Storage shutdown already closes its connection in a finally block.
            # Keep the original activation failure private and fail liveness.
            pass

    async def create_candidate():
        creation = asyncio.create_task(asyncio.to_thread(RoiService, settings, provider, clock))
        try:
            return await asyncio.shield(creation)
        except asyncio.CancelledError:
            # A cancelled to_thread operation keeps running. Drain and close it
            # so shutdown cannot strand the database's writer lock.
            while not creation.done():
                try:
                    await asyncio.shield(creation)
                except asyncio.CancelledError:
                    continue
                except Exception:
                    break
            if not creation.cancelled() and creation.exception() is None:
                await close_candidate(creation.result())
            raise

    async def activate():
        nonlocal service, outlines, outlets, startup_failed
        deadline = time.monotonic() + STORAGE_ACTIVATION_TIMEOUT_SECONDS
        while service is None and not startup_failed and time.monotonic() < deadline:
            candidate = None
            try:
                candidate = await create_candidate()
                candidate.persist()
                await candidate.flush()
            except SupabaseWriterBusy:
                await asyncio.sleep(STORAGE_ACTIVATION_RETRY_SECONDS)
                continue
            except asyncio.CancelledError:
                if candidate is not None:
                    await close_candidate(candidate)
                raise
            except Exception:
                startup_failed = True
                if candidate is not None:
                    await close_candidate(candidate)
                logger.error("ROI storage activation failed; check Supabase configuration and connectivity")
                return
            if startup_failed:
                await close_candidate(candidate)
                return
            outlines, outlets = OutlineService(candidate), OutletService(candidate)
            service = candidate
            application.state.roi_service = candidate
            return
        if service is None and not startup_failed:
            startup_failed = True
            logger.error("ROI storage activation timed out; keep one backend instance and one worker")

    async def activation_watchdog():
        nonlocal startup_failed
        await asyncio.sleep(STORAGE_ACTIVATION_TIMEOUT_SECONDS)
        if service is None:
            # A synchronous connection/download thread may outlive the deadline;
            # fail liveness on time while shutdown safely drains that thread.
            startup_failed = True
            logger.error("ROI storage activation timed out; check Supabase connectivity and writer ownership")

    @asynccontextmanager
    async def lifespan(_app):
        # Commit startup expiry cleanup before serving requests. Network storage
        # writes run in a worker thread so health checks remain responsive.
        activation_task = None
        watchdog_task = None
        if service is not None:
            try:
                if getattr(service.store, "deferred", False):
                    service.persist()
                await service.flush()
            except BaseException:
                await close_candidate(service)
                raise
        else:
            activation_task = asyncio.create_task(activate())
            watchdog_task = asyncio.create_task(activation_watchdog())

        async def cleanup():
            while True:
                await asyncio.sleep(settings.cleanup_interval_seconds)
                if service is None:
                    continue
                try:
                    service.cleanup()
                    if getattr(service.store, "deferred", False):
                        # Retry the remote deletion outbox and verify writer ownership
                        # even when no page or call counter has expired this interval.
                        service.persist()
                    await service.flush()
                except RoiError:
                    logger.warning("ROI durable storage is unavailable; waiting for service recovery")

        cleanup_task = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            cleanup_task.cancel()
            await asyncio.gather(cleanup_task, return_exceptions=True)
            if activation_task is not None:
                activation_task.cancel()
                await asyncio.gather(activation_task, return_exceptions=True)
            if watchdog_task is not None:
                watchdog_task.cancel()
                await asyncio.gather(watchdog_task, return_exceptions=True)
            if service is not None:
                await service.close()
            else:
                await provider.close()

    application = FastAPI(title="TaperedPlus ROI API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    application.state.roi_service = service
    application.add_middleware(BoundedRequests, settings=settings,
                               available=lambda: service is not None and service.storage_available)
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=list(settings.allowed_hosts))
    application.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins),
                               allow_methods=["GET", "POST", "DELETE"], allow_headers=["Authorization", "Content-Type"],
                               allow_credentials=False)

    @application.exception_handler(RoiError)
    async def roi_error(_request, error):
        return error_response(error)

    @application.exception_handler(RequestValidationError)
    @application.exception_handler(ValidationError)
    async def invalid_request(_request, _error):
        return error_response(RoiError("invalid_request"))

    @application.exception_handler(HTTPException)
    async def http_error(_request, error):
        return error_response(RoiError("invalid_request", error.status_code))

    @application.get(PREFIX + "/health")
    async def health():
        if service is None:
            return error_response(RoiError("storage_starting", 503, retryable=True))
        if not service.storage_available:
            return error_response(RoiError("storage_unavailable", 503, retryable=True))
        return JSONResponse({"status": "ready" if service.provider.ready else "not_configured",
                             "model": settings.model, "mode": settings.deployment_mode}, headers={"Cache-Control": "no-store"})

    @application.get("/healthz")
    async def deployment_health():
        # Platform liveness must allow validated standby during Render's overlap.
        # API readiness above stays unavailable until fresh state is restored.
        if startup_failed or (service is not None and not service.storage_available):
            return error_response(RoiError("storage_unavailable", 503, retryable=True))
        return JSONResponse({"status": "standby" if service is None else "ready"},
                            headers={"Cache-Control": "no-store"})

    @application.post(PREFIX + "/pages")
    async def upload(request: Request):
        owner = owner_from_headers(request.headers)
        if image_slots.locked():
            raise RoiError("upload_concurrency_limit_exceeded", 429)
        async with image_slots:
            async with request.form(max_files=1, max_fields=1, max_part_size=8192) as form:
                if len(form.multi_items()) != 2 or set(form) != {"image", "context"}:
                    raise RoiError("invalid_upload")
                image_file, context_text = form["image"], form["context"]
                if not isinstance(image_file, UploadFile) or not isinstance(context_text, str):
                    raise RoiError("invalid_upload")
                context = PageContext.model_validate(decode_json(context_text))
                data = await image_file.read(settings.max_upload_bytes + 1)
                preparation = asyncio.create_task(asyncio.to_thread(prepare_image, data, settings))
                try:
                    image = await asyncio.shield(preparation)
                except asyncio.CancelledError:
                    await asyncio.gather(preparation, return_exceptions=True)
                    raise
        receipt = service.upload(owner, context, image)
        await service.flush()
        return JSONResponse(receipt, headers={"Cache-Control": "no-store"})

    @application.post(PREFIX + "/pages/{page_id}/detections")
    async def detect(page_id: str, request: Request):
        owner = owner_from_headers(request.headers)
        try:
            body = (await request.body()).decode("utf-8")
        except UnicodeDecodeError:
            raise RoiError("invalid_request") from None
        detection = DetectionInput.model_validate(decode_json(body))
        if page_id != detection.page_id:
            raise RoiError("page_identity_conflict", 409)
        response = await service.detect(owner, detection)
        return JSONResponse(response.model_dump(mode="json"), headers={"Cache-Control": "no-store"})

    @application.post(PREFIX + "/pages/{page_id}/outlines")
    async def generate_outline(page_id: str, request: Request):
        owner = owner_from_headers(request.headers)
        try:
            body = (await request.body()).decode("utf-8")
        except UnicodeDecodeError:
            raise RoiError("invalid_request") from None
        outline = OutlineInput.model_validate(decode_json(body))
        if page_id != outline.page_id:
            raise RoiError("page_identity_conflict", 409)
        response = await outlines.generate(owner, outline)
        return JSONResponse(response.model_dump(mode="json"), headers={"Cache-Control": "no-store"})

    @application.post(PREFIX + "/pages/{page_id}/outlets")
    async def generate_outlets(page_id: str, request: Request):
        owner = owner_from_headers(request.headers)
        try:
            body = (await request.body()).decode("utf-8")
        except UnicodeDecodeError:
            raise RoiError("invalid_request") from None
        outlet = OutletInput.model_validate(decode_json(body))
        if page_id != outlet.page_id:
            raise RoiError("page_identity_conflict", 409)
        response = await outlets.generate(owner, outlet)
        return JSONResponse(response.model_dump(mode="json"), headers={"Cache-Control": "no-store"})

    @application.delete(PREFIX + "/pages/{page_id}", status_code=204)
    async def delete(page_id: str, request: Request):
        service.delete(owner_from_headers(request.headers), page_id)
        await service.flush()
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    return application


app = create_app()
