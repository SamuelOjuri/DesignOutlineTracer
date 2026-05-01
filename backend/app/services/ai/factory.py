from app.services.ai.mock import MockProvider
from app.services.ai.provider import AiProvider


def get_ai_provider(provider_name: str) -> AiProvider:
    if provider_name != "mock":
        # Gemini is introduced in Phase 4; keep Phase 2 fully offline.
        return MockProvider()
    return MockProvider()
