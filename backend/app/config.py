import os
import ipaddress
import re
from typing import Annotated, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, SecretStr, model_validator

from .models import DEFAULT_MODEL, ModelName


LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def valid_hostname(value: str) -> bool:
    try:
        ipaddress.ip_address(value)
        return True
    except ValueError:
        return len(value) <= 253 and all(
            re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
            for label in value.split(".")
        )


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    model: ModelName = DEFAULT_MODEL
    thinking_level: Literal["low", "medium", "high"] = "medium"
    temperature: Annotated[float, Field(ge=0, le=2, allow_inf_nan=False)] = 0.5
    allow_live: bool = False
    api_key: SecretStr | None = Field(default=None, exclude=True)
    structured_output: bool = False
    # "shapely" repairs model outlines and removes sub-snapping-radius artefacts before fitting.
    # Benchmarked: 2 extra usable outlines, identical results elsewhere (docs/roi-evaluation/outline-benchmark.md).
    outline_cleanup: Literal["none", "shapely"] = "shapely"
    # Constrain the reply to JSON without sending a schema (gemini-4-argon rejects response
    # schemas). Measured on outlines: 13/13 parsed vs 9/13 free-form (docs/roi-evaluation/outline-benchmark.md).
    json_mode: bool = True
    deployment_mode: Literal["localhost_only", "public"] = "localhost_only"
    allowed_origins: tuple[str, ...] = ("http://127.0.0.1:8080", "http://localhost:8080")
    allowed_hosts: tuple[str, ...] = ("localhost", "127.0.0.1", "[::1]")
    # Use a path on a persistent Render disk in public mode. One process owns this store.
    state_path: str | None = None
    max_upload_bytes: Annotated[int, Field(gt=0, le=40 * 1024 * 1024)] = 20 * 1024 * 1024
    max_decoded_pixels: Annotated[int, Field(gt=0, le=80_000_000)] = 40_000_000
    max_annotations: Annotated[int, Field(gt=0, le=25)] = 25
    max_response_bytes: Annotated[int, Field(gt=0, le=1024 * 1024)] = 256 * 1024
    max_output_tokens: Annotated[int, Field(ge=256, le=65536)] = 32768
    timeout_seconds: Annotated[float, Field(gt=0, le=900)] = 900
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
    call_budget_window_seconds: Annotated[float, Field(gt=0, le=86400 * 31)] = 86400
    max_storage_bytes: Annotated[int, Field(gt=0, le=1024 * 1024 * 1024)] = 256 * 1024 * 1024
    page_ttl_seconds: Annotated[float, Field(gt=0, le=3600)] = 1800
    cache_ttl_seconds: Annotated[float, Field(gt=0, le=900)] = 300
    session_ttl_seconds: Annotated[float, Field(gt=0, le=86400)] = 3600
    cleanup_interval_seconds: Annotated[float, Field(gt=0, le=60)] = 30

    @property
    def generation_settings(self) -> dict:
        settings: dict = {"max_output_tokens": self.max_output_tokens}
        if self.model == "gemini-4-argon":
            settings["thinking_config"] = {"thinking_level": self.thinking_level.upper()}
        else:
            settings["temperature"] = self.temperature
        return settings

    @model_validator(mode="after")
    def deployment_settings(self):
        if not self.allowed_origins:
            raise ValueError("allowed_origins_required")
        for origin in self.allowed_origins:
            try:
                parsed = urlsplit(origin)
                port = parsed.port
                valid = (bool(parsed.hostname) and valid_hostname(parsed.hostname)
                         and not any(char.isspace() or ord(char) < 32 for char in origin)
                         and not parsed.path and not parsed.query and not parsed.fragment
                         and parsed.username is None and parsed.password is None
                         and "?" not in origin and "#" not in origin
                         and not parsed.netloc.endswith(":") and (port is None or port > 0))
            except ValueError:
                valid = False
            if not valid:
                raise ValueError("invalid_allowed_origin")
            if self.deployment_mode == "localhost_only" and (
                    parsed.scheme != "http" or parsed.hostname not in LOOPBACK_HOSTS):
                raise ValueError("localhost_origins_required")
            if self.deployment_mode == "public" and parsed.scheme != "https":
                raise ValueError("https_origins_required")
        if not self.allowed_hosts:
            raise ValueError("allowed_hosts_required")
        for host in self.allowed_hosts:
            normalized = host[1:-1] if host.startswith("[") and host.endswith("]") else host
            if not valid_hostname(normalized) or (":" in host and host != "[::1]"):
                raise ValueError("invalid_allowed_host")
            if self.deployment_mode == "localhost_only" and normalized not in LOOPBACK_HOSTS:
                raise ValueError("localhost_hosts_required")
        if self.state_path is not None and (not self.state_path.strip() or self.state_path == ":memory:"):
            raise ValueError("invalid_state_path")
        if self.deployment_mode == "public":
            if self.state_path is None:
                raise ValueError("persistent_state_path_required")
            if all(host.strip("[]") in LOOPBACK_HOSTS for host in self.allowed_hosts):
                raise ValueError("public_host_required")
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
                values[name] = (tuple(item.strip() for item in value.split(","))
                                if name in {"allowed_origins", "allowed_hosts"} else value)
        if values.get("deployment_mode") == "public" and "allowed_hosts" not in values:
            render_hostname = os.environ.get("RENDER_EXTERNAL_HOSTNAME")
            if render_hostname:
                values["allowed_hosts"] = (*cls.model_fields["allowed_hosts"].default, render_hostname)
        values["api_key"] = os.environ.get("GOOGLE_API_KEY") or None
        return cls.model_validate(values)
