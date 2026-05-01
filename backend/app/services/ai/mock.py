from app.services.ai.provider import AiProvider


class MockProvider(AiProvider):
    """Deterministic offline provider used by default in tests."""

    @property
    def name(self) -> str:
        return "mock"
