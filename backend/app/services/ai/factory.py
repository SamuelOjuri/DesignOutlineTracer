from app.config import Settings
from app.services.ai.gemini import GeminiProvider
from app.services.ai.mock import MockProvider
from app.services.ai.provider import AiProvider


def get_ai_provider(provider_name: str, settings: Settings | None = None) -> AiProvider:
    if provider_name == "gemini":
        if settings is None or not settings.google_api_key:
            return MockProvider()
        return GeminiProvider(
            api_key=settings.google_api_key,
            flash_model=settings.gemini_validation_model,
            pro_model=settings.gemini_pro_model,
            allow_pro_escalation=settings.allow_gemini_pro_escalation,
            pro_escalation_confidence_threshold=(
                settings.gemini_pro_escalation_confidence_threshold
            ),
        )
    return MockProvider()
