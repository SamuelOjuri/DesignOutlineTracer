import os
from typing import Any

import httpx
from google import genai
from google.auth.exceptions import GoogleAuthError
from google.genai import errors, types

from .contracts import MODEL, ReferenceError


def create_client(provider: str, config: dict) -> genai.Client:
    options = types.HttpOptions(
        api_version=config["api_versions"][provider],
        timeout=config["timeout_ms"],
        retry_options=types.HttpRetryOptions(attempts=1),
    )
    if provider == "developer":
        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise ReferenceError("missing_google_api_key")
        return genai.Client(vertexai=False, api_key=api_key, http_options=options)
    if provider == "vertex":
        project = os.environ.get("GOOGLE_CLOUD_PROJECT")
        location = os.environ.get("GOOGLE_CLOUD_LOCATION")
        if not project or not location:
            raise ReferenceError("missing_vertex_project_or_location")
        try:
            return genai.Client(
                vertexai=True, project=project, location=location, http_options=options
            )
        except GoogleAuthError:
            raise ReferenceError("authentication_failed") from None
    raise ReferenceError("invalid_provider")


def generate(client: genai.Client, request: dict, image: bytes) -> dict[str, Any]:
    try:
        response = client.models.generate_content(
            model=MODEL,
            contents=[
                types.Part.from_text(text=request["prompt"]),
                types.Part.from_bytes(data=image, mime_type="image/png"),
            ],
            config=types.GenerateContentConfig(**request["generation_config"]),
        )
    except errors.APIError as error:
        code = {
            400: "unsupported_request_or_settings",
            401: "authentication_failed",
            403: "permission_denied",
            404: "model_unavailable",
            429: "rate_limited",
        }.get(error.code, "provider_unavailable")
        raise ReferenceError(code) from None
    except GoogleAuthError:
        raise ReferenceError("authentication_failed") from None
    except httpx.TimeoutException:
        raise ReferenceError("provider_timeout") from None
    except httpx.HTTPError:
        raise ReferenceError("provider_transport_error") from None
    return response.model_dump(
        mode="json", exclude_none=True,
        exclude={"sdk_http_response", "automatic_function_calling_history", "parsed"},
    )