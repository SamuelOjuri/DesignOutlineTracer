from dataclasses import dataclass
import json
from pathlib import Path
from typing import Protocol

import httpx
from google import genai
from google.auth.exceptions import GoogleAuthError
from google.genai import errors, types

from .config import Settings
from .errors import OutputDiagnostic, RoiError
from .models import AcceptedRoi, SUBTYPES, Task


PROMPT_VERSIONS = {"roof_roi": "roof-roi-v1", "penetration": "penetration-draft-v1",
                   "rainwater_outlet": "rainwater-outlet-draft-v1"}
PROMPTS = Path(__file__).parent / "prompts"
SYSTEM_PROMPT = (PROMPTS / "system-v1.txt").read_text(encoding="utf-8")
TASK_PROMPTS = {task: (PROMPTS / f"{version}.txt").read_text(encoding="utf-8")
                for task, version in PROMPT_VERSIONS.items()}


@dataclass(frozen=True)
class ProviderResult:
    text: str
    finish_reason: str = "STOP"


class Provider(Protocol):
    @property
    def ready(self) -> bool: ...

    async def generate(self, image: bytes, prompt: str, schema: dict) -> ProviderResult: ...

    async def close(self) -> None: ...


def make_prompt(task: Task, parents: list[AcceptedRoi], maximum: int) -> str:
    prompt = TASK_PROMPTS[task] + f"\nReturn at most {maximum} objects."
    if parents:
        prompt += "\nAccepted ROIs: " + json.dumps(
            [parent.model_dump() for parent in sorted(parents, key=lambda parent: parent.id)],
            sort_keys=True, separators=(",", ":"),
        )
    return prompt


def response_schema(task: Task, parents: list[AcceptedRoi], maximum: int) -> dict:
    properties = {
        "label": {"type": "string"},
        "box_2d": {"type": "array", "items": {"type": "number", "minimum": 0, "maximum": 1000},
                   "minItems": 4, "maxItems": 4},
    }
    if task != "roof_roi":
        properties["roi_id"] = {"type": "string", "enum": sorted(parent.id for parent in parents)}
        properties["subtype"] = {"type": "string", "enum": list(SUBTYPES[task])}
    return {"type": "array", "maxItems": maximum, "items": {
        "type": "object", "properties": properties, "required": list(properties), "additionalProperties": False,
    }}


class GeminiProvider:
    def __init__(self, settings: Settings, client: genai.Client | None = None):
        self.settings = settings
        self.client = client

    @property
    def ready(self) -> bool:
        return self.settings.allow_live and bool(self.settings.api_key)

    def get_client(self) -> genai.Client:
        if not self.ready:
            raise RoiError("provider_not_configured", 503)
        if self.client is None:
            self.client = genai.Client(
                vertexai=False, api_key=self.settings.api_key.get_secret_value(),
                http_options=types.HttpOptions(
                    api_version="v1beta", timeout=int(self.settings.timeout_seconds * 1000),
                    retry_options=types.HttpRetryOptions(attempts=1),
                ),
            )
        return self.client

    async def generate(self, image: bytes, prompt: str, schema: dict) -> ProviderResult:
        config = types.GenerateContentConfig(
            temperature=0.5, max_output_tokens=self.settings.max_output_tokens,
            system_instruction=SYSTEM_PROMPT,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        )
        if self.settings.structured_output:
            config.response_mime_type = "application/json"
            config.response_json_schema = schema
        try:
            stream = await self.get_client().aio.models.generate_content_stream(
                model=self.settings.model,
                contents=[types.Part.from_text(text=prompt), types.Part.from_bytes(data=image, mime_type="image/png")],
                config=config,
            )
            text_parts = []
            total_bytes = 0
            finish_reason = None
            try:
                async for chunk in stream:
                    total_bytes += len(chunk.model_dump_json(exclude_none=True).encode("utf-8"))
                    if total_bytes > self.settings.max_response_bytes:
                        raise RoiError("response_too_large", 502)
                    if chunk.prompt_feedback and chunk.prompt_feedback.block_reason:
                        raise RoiError("provider_refusal", 502)
                    if not chunk.candidates:
                        continue
                    if len(chunk.candidates) != 1:
                        raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.STREAM_CANDIDATE_COUNT)
                    candidate = chunk.candidates[0]
                    if candidate.finish_reason:
                        finish_reason = candidate.finish_reason.value
                    if candidate.content:
                        for part in candidate.content.parts or []:
                            if part.text and not part.thought:
                                text_parts.append(part.text)
            finally:
                await stream.aclose()
            if finish_reason in {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"}:
                raise RoiError("provider_refusal", 502)
            if finish_reason is None:
                raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.STREAM_MISSING_FINISH)
            if finish_reason not in {"STOP", "MAX_TOKENS"}:
                raise RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.STREAM_UNEXPECTED_FINISH)
            return ProviderResult("".join(text_parts), finish_reason)
        except errors.APIError as error:
            code = {400: "unsupported_request_or_settings", 401: "authentication_failed",
                    403: "permission_denied", 404: "model_unavailable", 429: "rate_limited"}.get(
                        error.code, "provider_unavailable")
            raise RoiError(code, 502, error.code in {429, 500, 502, 503, 504}) from None
        except GoogleAuthError:
            raise RoiError("authentication_failed", 502) from None
        except httpx.TimeoutException:
            raise RoiError("provider_timeout", 504) from None
        except httpx.HTTPError:
            raise RoiError("provider_transport_error", 502, True) from None

    async def close(self) -> None:
        if self.client is not None:
            await self.client.aio.aclose()
            self.client.close()