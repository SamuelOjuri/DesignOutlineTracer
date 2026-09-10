import os
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    model: Literal["gemini-3.6-flash"] = "gemini-3.6-flash"
    allow_live: bool = False
    api_key: SecretStr | None = Field(default=None, exclude=True)
    structured_output: bool = False
    allowed_origins: tuple[str, ...] = ("http://127.0.0.1:8080", "http://localhost:8080")
    max_upload_bytes: Annotated[int, Field(gt=0, le=40 * 1024 * 1024)] = 20 * 1024 * 1024
    max_decoded_pixels: Annotated[int, Field(gt=0, le=80_000_000)] = 40_000_000
    max_annotations: Annotated[int, Field(gt=0, le=25)] = 25
    max_response_bytes: Annotated[int, Field(gt=0, le=1024 * 1024)] = 256 * 1024
    max_output_tokens: Annotated[int, Field(ge=256, le=8192)] = 4096
    timeout_seconds: Annotated[float, Field(gt=0, le=120)] = 60
    upload_timeout_seconds: Annotated[float, Field(gt=0, le=120)] = 30
    max_attempts: Annotated[int, Field(ge=1, le=2)] = 2
    max_concurrent_requests: Annotated[int, Field(gt=0, le=8)] = 2
    max_image_preparations: Annotated[int, Field(gt=0, le=2)] = 1
    max_http_requests: Annotated[int, Field(gt=0, le=16)] = 8
    max_sessions: Annotated[int, Field(gt=0, le=100)] = 20
    max_pages_per_session: Annotated[int, Field(gt=0, le=20)] = 8
    max_requests_per_session: Annotated[int, Field(gt=0, le=200)] = 100
    max_calls_per_session: Annotated[int, Field(gt=0, le=100)] = 12
    max_total_calls: Annotated[int, Field(gt=0, le=1000)] = 100
    max_storage_bytes: Annotated[int, Field(gt=0, le=1024 * 1024 * 1024)] = 256 * 1024 * 1024
    page_ttl_seconds: Annotated[float, Field(gt=0, le=3600)] = 900
    cache_ttl_seconds: Annotated[float, Field(gt=0, le=900)] = 300
    session_ttl_seconds: Annotated[float, Field(gt=0, le=86400)] = 3600
    cleanup_interval_seconds: Annotated[float, Field(gt=0, le=60)] = 30

    @model_validator(mode="after")
    def local_origins_only(self):
        for origin in self.allowed_origins:
            parsed = urlsplit(origin)
            if (parsed.scheme != "http" or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
                    or parsed.path or parsed.query or parsed.fragment or parsed.username or parsed.password):
                raise ValueError("localhost_origins_required")
        if self.cache_ttl_seconds > self.page_ttl_seconds:
            raise ValueError("cache_lifetime_exceeds_page")
        return self

    @classmethod
    def from_env(cls):
        values = {}
        for name in cls.model_fields:
            if name == "api_key":
                continue
            value = os.environ.get(f"ROI_{name.upper()}")
            if value is not None:
                values[name] = tuple(item.strip() for item in value.split(",")) if name == "allowed_origins" else value
        values["api_key"] = os.environ.get("GOOGLE_API_KEY") or None
        return cls.model_validate(values)