"""Small adapter around the newer ``google-genai`` SDK.

The rest of the backend depends on plain callables and dictionaries so unit
tests can stay offline. This module is the only place that imports the SDK.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from PIL import Image

ImagePromptModelCall = Callable[[Image.Image, str], str]


def generate_gemini_json(
    *,
    api_key: str,
    model_name: str,
    prompt: str,
    response_schema: dict[str, Any],
    image_path: str | None = None,
    temperature: float = 0.2,
) -> dict[str, Any]:
    """Generate strict JSON with the newer ``google-genai`` SDK."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    contents: list[Any] = [prompt]
    if image_path is not None:
        image = Image.open(Path(image_path))
        image.load()
        contents.append(image)

    response = client.models.generate_content(
        model=model_name,
        contents=contents,
        config=types.GenerateContentConfig(
            temperature=temperature,
            response_mime_type="application/json",
            response_schema=response_schema,
        ),
    )
    return cast(dict[str, Any], json.loads(response.text or "{}"))


def build_gemini_er_model_call(
    *,
    api_key: str,
    model_name: str = "gemini-robotics-er-1.5-preview",
    temperature: float = 0.5,
    thinking_budget: int = 0,
) -> ImagePromptModelCall:
    """Build a Robotics-ER image+prompt callable for anchors and segmentation."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        temperature=temperature,
        thinking_config=types.ThinkingConfig(thinking_budget=thinking_budget),
    )

    def call(image: Image.Image, prompt: str) -> str:
        response = client.models.generate_content(
            model=model_name,
            contents=[image, prompt],
            config=config,
        )
        return response.text or "[]"

    return call


def build_gemini_image_prompt_model_call(
    *,
    api_key: str,
    model_name: str,
    temperature: float = 0.1,
    response_mime_type: str | None = None,
) -> ImagePromptModelCall:
    """Build a generic image+prompt callable for Gemini vision tasks."""
    from google import genai
    from google.genai import types

    client = genai.Client(api_key=api_key)
    config = types.GenerateContentConfig(
        temperature=temperature,
        response_mime_type=response_mime_type,
    )

    def call(image: Image.Image, prompt: str) -> str:
        response = client.models.generate_content(
            model=model_name,
            contents=[image, prompt],
            config=config,
        )
        return response.text or "[]"

    return call
