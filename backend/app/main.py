import asyncio
from contextlib import asynccontextmanager
from hashlib import sha256
import json
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
from .parsing import reject_constant, unique_object
from .service import RoiService


PREFIX = "/api/roi/v1"


def error_response(error: RoiError) -> JSONResponse:
    return JSONResponse({"error": {"code": error.code, "retryable": error.retryable}}, status_code=error.status,
                        headers={"Cache-Control": "no-store"})


def owner_from_headers(headers) -> str:
    authorization = headers.get("authorization", "")
    if not re.fullmatch(r"Bearer [a-f0-9]{64}", authorization):
        raise RoiError("session_token_required", 401)
    return sha256(authorization[7:].encode()).hexdigest()


class BoundedRequests:
    def __init__(self, app, settings: Settings):
        self.app = app
        self.settings = settings
        self.active = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.decode("latin1"): value.decode("latin1") for key, value in scope["headers"]}
        try:
            if not scope.get("client") or scope["client"][0] not in {"127.0.0.1", "::1"}:
                raise RoiError("localhost_only", 403)
            if headers.get("origin") is not None and headers["origin"] not in self.settings.allowed_origins:
                raise RoiError("origin_not_allowed", 403)
            if self.active >= self.settings.max_http_requests:
                raise RoiError("http_concurrency_limit_exceeded", 429)
            if scope["method"] in {"POST", "DELETE"}:
                owner_from_headers(headers)
        except RoiError as error:
            return await error_response(error)(scope, receive, send)
        self.active += 1
        try:
            bounded_receive = receive
            if scope["method"] == "POST":
                maximum = self.settings.max_upload_bytes + 16384 if scope["path"] == PREFIX + "/pages" else 65536
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
    service = RoiService(settings, provider or GeminiProvider(settings), clock)
    image_slots = asyncio.Semaphore(settings.max_image_preparations)

    @asynccontextmanager
    async def lifespan(_app):
        async def cleanup():
            while True:
                await asyncio.sleep(settings.cleanup_interval_seconds)
                service.cleanup()

        cleanup_task = asyncio.create_task(cleanup())
        try:
            yield
        finally:
            cleanup_task.cancel()
            await asyncio.gather(cleanup_task, return_exceptions=True)
            await service.close()

    application = FastAPI(title="Isolated ROI API", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    application.state.roi_service = service
    application.add_middleware(BoundedRequests, settings=settings)
    application.add_middleware(TrustedHostMiddleware, allowed_hosts=["localhost", "127.0.0.1", "[::1]"])
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
        return JSONResponse({"status": "ready" if service.provider.ready else "not_configured",
                             "model": settings.model, "mode": "localhost_only"}, headers={"Cache-Control": "no-store"})

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
        return JSONResponse(service.upload(owner, context, image), headers={"Cache-Control": "no-store"})

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

    @application.delete(PREFIX + "/pages/{page_id}", status_code=204)
    async def delete(page_id: str, request: Request):
        service.delete(owner_from_headers(request.headers), page_id)
        return Response(status_code=204, headers={"Cache-Control": "no-store"})

    return application


app = create_app()