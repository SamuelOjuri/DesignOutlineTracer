from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import candidates, documents, extraction, health, validation
from app.config import Settings, get_settings
from app.logging import configure_logging


def build_lifespan(settings: Settings) -> Callable[[FastAPI], AbstractAsyncContextManager[None]]:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        settings.storage_path.mkdir(parents=True, exist_ok=True)
        app.state.settings = settings
        yield

    return lifespan


def create_app(settings: Settings | None = None) -> FastAPI:
    configure_logging()
    resolved_settings = settings or get_settings()
    app = FastAPI(title=resolved_settings.app_name, lifespan=build_lifespan(resolved_settings))
    app.state.settings = resolved_settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=resolved_settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(health.router)
    app.include_router(documents.router, prefix=resolved_settings.api_prefix)
    app.include_router(extraction.router, prefix=resolved_settings.api_prefix)
    app.include_router(candidates.router, prefix=resolved_settings.api_prefix)
    app.include_router(validation.router, prefix=resolved_settings.api_prefix)
    return app


app = create_app()
