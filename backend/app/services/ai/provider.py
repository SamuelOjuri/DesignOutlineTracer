from typing import Protocol


class AiProvider(Protocol):
    """Common interface for model-backed semantic helpers."""

    @property
    def name(self) -> str: ...
