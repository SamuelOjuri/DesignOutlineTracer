import os
import ipaddress
import re
from typing import Annotated, Literal
from urllib.parse import parse_qs, urlsplit

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
    model_config = ConfigDict(extra="forbid", frozen=True, hide_input_in_errors=True)

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
    storage_backend: Literal["auto", "memory", "sqlite", "supabase"] = "auto"
    supabase_url: str | None = None
    supabase_secret_key: SecretStr | None = Field(default=None, exclude=True)
    database_url: SecretStr | None = Field(default=None, exclude=True)
    storage_bucket: str = "roi-pages"
    # SQLite fallback uses a persistent disk. Both durable stores have one writer.
    state_path: str | None = None
    max_upload_bytes: Annotated[int, Field(gt=0, le=40 * 1024 * 1024)] = 20 * 1024 * 1024
    max_decoded_pixels: Annotated[int, Field(gt=0, le=80_000_000)] = 40_000_000
    max_annotations: Annotated[int, Field(gt=0, le=25)] = 25
    max_response_bytes: Annotated[int, Field(gt=0, le=1024 * 1024)] = 256 * 1024
    max_output_tokens: Annotated[int, Field(ge=256, le=65536)] = 32768
    timeout_seconds: Annotated[float, Field(gt=0, le=900)] = 900
    # Each outlet crop call; a stalled call is abandoned and retried within timeout_seconds.
    outlet_call_timeout_seconds: Annotated[float, Field(gt=0, le=900)] = 120
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

    @model_validator(mode="before")
    @classmethod
    def protect_secret_inputs(cls, values):
        # A model-level validation error retains its input mapping. Mask credentials
        # before any later validator can reject that mapping during startup.
        if isinstance(values, dict):
            for name in ("api_key", "supabase_secret_key", "database_url"):
                if isinstance(values.get(name), str):
                    values[name] = SecretStr(values[name])
        return values

    @property
    def resolved_storage_backend(self) -> Literal["memory", "sqlite", "supabase"]:
        if self.storage_backend != "auto":
            return self.storage_backend
        if all(value is not None for value in (self.supabase_url, self.supabase_secret_key, self.database_url)):
            return "supabase"
        return "sqlite" if self.state_path else "memory"

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
        supplied_supabase = [value is not None for value in (self.supabase_url, self.supabase_secret_key, self.database_url)]
        if self.storage_backend in {"auto", "supabase"} and any(supplied_supabase) and not all(supplied_supabase):
            raise ValueError("supabase_configuration_incomplete")
        if self.resolved_storage_backend == "supabase":
            if not all(supplied_supabase):
                raise ValueError("supabase_configuration_required")
            if not self.supabase_secret_key.get_secret_value().strip():
                raise ValueError("supabase_secret_key_required")
            try:
                project_url = urlsplit(self.supabase_url)
                valid_project = (project_url.scheme == "https" and bool(project_url.hostname)
                                 and valid_hostname(project_url.hostname) and project_url.port in {None, 443}
                                 and not project_url.path and not project_url.query and not project_url.fragment
                                 and project_url.username is None and project_url.password is None
                                 and "?" not in self.supabase_url and "#" not in self.supabase_url
                                 and not project_url.netloc.endswith(":")
                                 and not any(char.isspace() or ord(char) < 32 for char in self.supabase_url))
            except ValueError:
                valid_project = False
            if not valid_project:
                raise ValueError("invalid_supabase_url")
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", self.storage_bucket):
                raise ValueError("invalid_storage_bucket")
            try:
                connection = self.database_url.get_secret_value()
                parsed_database = urlsplit(connection)
                ssl_modes = parse_qs(parsed_database.query, keep_blank_values=True).get("sslmode", [])
                valid_database = (parsed_database.scheme in {"postgres", "postgresql"}
                                  and bool(parsed_database.hostname) and valid_hostname(parsed_database.hostname)
                                  and bool(parsed_database.username) and bool(parsed_database.password)
                                  and parsed_database.port in {None, 5432}
                                  and parsed_database.path not in {"", "/"}
                                  and parsed_database.path.count("/") == 1 and not parsed_database.fragment
                                  and "#" not in connection and not parsed_database.netloc.endswith(":")
                                  and not any(char.isspace() or ord(char) < 32 for char in connection)
                                  and all(mode in {"require", "verify-ca", "verify-full"} for mode in ssl_modes))
            except ValueError:
                valid_database = False
            if not valid_database:
                raise ValueError("invalid_database_url_use_direct_or_session_pooler_5432")
        if self.resolved_storage_backend == "sqlite" and not self.state_path:
            raise ValueError("sqlite_state_path_required")
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
            if self.resolved_storage_backend == "memory":
                raise ValueError("durable_storage_required")
            if all(host.strip("[]") in LOOPBACK_HOSTS for host in self.allowed_hosts):
                raise ValueError("public_host_required")
        if self.cache_ttl_seconds > self.page_ttl_seconds:
            raise ValueError("cache_lifetime_exceeds_page")
        return self

    @classmethod
    def from_env(cls):
        values = {}
        aliases = {"api_key": "GOOGLE_API_KEY", "supabase_url": "SUPABASE_URL",
                   "supabase_secret_key": "SUPABASE_SECRET_KEY", "database_url": "DATABASE_URL"}
        for name in cls.model_fields:
            value = os.environ.get(aliases.get(name, f"ROI_{name.upper()}"))
            if value is not None:
                values[name] = (tuple(item.strip() for item in value.split(","))
                                if name in {"allowed_origins", "allowed_hosts"} else value)
        if values.get("deployment_mode") == "public" and "allowed_hosts" not in values:
            render_hostname = os.environ.get("RENDER_EXTERNAL_HOSTNAME")
            if render_hostname:
                values["allowed_hosts"] = (*cls.model_fields["allowed_hosts"].default, render_hostname)
        return cls.model_validate(values)
