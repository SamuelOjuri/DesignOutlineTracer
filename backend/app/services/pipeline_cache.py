from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Generic, TypeVar

from pydantic import BaseModel

from app.config import Settings
from app.models.candidates import CandidateDocument
from app.models.validation import SemanticValidationResult
from app.models.vector import VectorDocument
from app.services.ai.provider import AiProvider
from app.services.storage.documents import upload_dir

CACHE_VERSION = 5

TModel = TypeVar("TModel", bound=BaseModel)


@dataclass(frozen=True)
class CacheResult(Generic[TModel]):
    value: TModel
    cache_hit: bool


class ArtifactMetadata(BaseModel):
    cache_version: int
    source_name: str
    source_size: int
    source_mtime_ns: int
    provider_key: str


_ARTIFACT_LOCKS: dict[str, Lock] = {}
_ARTIFACT_LOCKS_LOCK = Lock()


def provider_cache_key(provider: AiProvider, settings: Settings) -> str:
    if provider.name == "gemini":
        escalation = "pro" if settings.allow_gemini_pro_escalation else "flash_only"
        return (
            f"gemini:{settings.gemini_validation_model}:"
            f"{settings.gemini_pro_model}:{escalation}:"
            f"{settings.gemini_pro_escalation_confidence_threshold}"
        )
    return provider.name


def get_or_create_vector_document(
    *,
    storage_path: Path,
    document_id: str,
    source_path: Path,
    provider_key: str,
    create: Callable[[], VectorDocument],
) -> CacheResult[VectorDocument]:
    return _get_or_create_artifact(
        storage_path=storage_path,
        document_id=document_id,
        source_path=source_path,
        provider_key=provider_key,
        artifact_name="vector_document",
        model_type=VectorDocument,
        create=create,
    )


def get_or_create_candidate_document(
    *,
    storage_path: Path,
    document_id: str,
    source_path: Path,
    provider_key: str,
    create: Callable[[], CandidateDocument],
) -> CacheResult[CandidateDocument]:
    return _get_or_create_artifact(
        storage_path=storage_path,
        document_id=document_id,
        source_path=source_path,
        provider_key=provider_key,
        artifact_name="candidate_document",
        model_type=CandidateDocument,
        create=create,
    )


def get_or_create_validation_result(
    *,
    storage_path: Path,
    document_id: str,
    source_path: Path,
    provider_key: str,
    create: Callable[[], SemanticValidationResult],
) -> CacheResult[SemanticValidationResult]:
    return _get_or_create_artifact(
        storage_path=storage_path,
        document_id=document_id,
        source_path=source_path,
        provider_key=provider_key,
        artifact_name="semantic_validation",
        model_type=SemanticValidationResult,
        create=create,
    )


def _get_or_create_artifact(
    *,
    storage_path: Path,
    document_id: str,
    source_path: Path,
    provider_key: str,
    artifact_name: str,
    model_type: type[TModel],
    create: Callable[[], TModel],
) -> CacheResult[TModel]:
    artifact_path = _artifact_path(storage_path, document_id, artifact_name)
    metadata_path = _metadata_path(artifact_path)
    expected_metadata = _artifact_metadata(source_path, provider_key)
    with _artifact_lock(artifact_path):
        cached = _read_cached_model(
            artifact_path=artifact_path,
            metadata_path=metadata_path,
            expected_metadata=expected_metadata,
            model_type=model_type,
        )
        if cached is not None:
            return CacheResult(value=cached, cache_hit=True)

        value = create()
        _write_cached_model(
            artifact_path=artifact_path,
            metadata_path=metadata_path,
            metadata=expected_metadata,
            value=value,
        )
        return CacheResult(value=value, cache_hit=False)


def _artifact_path(storage_path: Path, document_id: str, artifact_name: str) -> Path:
    return upload_dir(storage_path, document_id) / "artifacts" / f"{artifact_name}.json"


def _metadata_path(artifact_path: Path) -> Path:
    return artifact_path.with_suffix(".meta.json")


def _artifact_metadata(source_path: Path, provider_key: str) -> ArtifactMetadata:
    stat = source_path.stat()
    return ArtifactMetadata(
        cache_version=CACHE_VERSION,
        source_name=source_path.name,
        source_size=stat.st_size,
        source_mtime_ns=stat.st_mtime_ns,
        provider_key=provider_key,
    )


def _artifact_lock(path: Path) -> Lock:
    key = str(path.resolve())
    with _ARTIFACT_LOCKS_LOCK:
        lock = _ARTIFACT_LOCKS.get(key)
        if lock is None:
            lock = Lock()
            _ARTIFACT_LOCKS[key] = lock
        return lock


def _read_cached_model(
    *,
    artifact_path: Path,
    metadata_path: Path,
    expected_metadata: ArtifactMetadata,
    model_type: type[TModel],
) -> TModel | None:
    if not artifact_path.exists() or not metadata_path.exists():
        return None
    try:
        metadata = ArtifactMetadata.model_validate_json(metadata_path.read_text(encoding="utf-8"))
        if metadata != expected_metadata:
            return None
        return model_type.model_validate_json(artifact_path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _write_cached_model(
    *,
    artifact_path: Path,
    metadata_path: Path,
    metadata: ArtifactMetadata,
    value: BaseModel,
) -> None:
    artifact_path.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write(artifact_path, value.model_dump_json(indent=2, by_alias=True))
    _atomic_write(metadata_path, metadata.model_dump_json(indent=2))


def _atomic_write(path: Path, content: str) -> None:
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(content, encoding="utf-8")
    temporary_path.replace(path)
