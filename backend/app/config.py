from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = BACKEND_ROOT.parent


class Settings(BaseSettings):
    app_name: str = "Design Outline Tracer Backend"
    app_env: str = "local"
    api_prefix: str = "/api"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    storage_root: Path = Path("storage")
    ai_provider: str = "mock"
    gemini_validation_model: str = "gemini-2.5-flash"
    gemini_pro_model: str = "gemini-2.5-pro"

    google_api_key: str | None = None
    openai_api_key: str | None = None
    mistralai_api_key: str | None = None

    raster_ocr_provider: str = "gemini"
    gemini_ocr_model: str = "gemini-2.5-flash"
    raster_render_dpi: int = 400
    ocr_cache_dir: Path = Path("storage/cache/ocr")
    ocr_max_tiles: int = 12

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_ROOT / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    @property
    def storage_path(self) -> Path:
        if self.storage_root.is_absolute():
            return self.storage_root
        return BACKEND_ROOT / self.storage_root


@lru_cache
def get_settings() -> Settings:
    return Settings()
