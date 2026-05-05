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
    ai_provider: str = "gemini"
    gemini_validation_model: str = "gemini-2.5-flash"
    gemini_pro_model: str = "gemini-2.5-pro"

    google_api_key: str | None = None
    openai_api_key: str | None = None
    mistralai_api_key: str | None = None

    raster_ocr_provider: str = "gemini"
    raster_preview_dpi: int = 125
    gemini_ocr_model: str = "gemini-2.5-flash"
    raster_render_dpi: int = 300
    raster_max_render_pixels: int = 80_000_000
    raster_max_tile_pixels: int = 5_000_000
    ocr_cache_dir: Path = Path("storage/cache/ocr")
    ocr_tile_size_px: int = 2048
    ocr_tile_overlap_px: int = 256
    ocr_max_tiles: int = 12
    allow_live_ai_calls: bool = False
    allow_gemini_pro_escalation: bool = False
    gemini_pro_escalation_confidence_threshold: float = 0.75
    segmentation_provider: str = "noop"
    falcon_perception_base_url: str | None = None
    falcon_perception_timeout_seconds: int = 60
    falcon_perception_max_image_dimension: int = 1024
    falcon_perception_min_image_dimension: int = 256
    falcon_perception_max_prompts: int = 4
    falcon_perception_cache_dir: Path = Path("storage/cache/segmentation")

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
