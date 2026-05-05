from fastapi import APIRouter, HTTPException, Request, status

from app.models.candidates import CandidateDocument
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.geometry.candidates import generate_candidate_document
from app.services.pipeline_cache import (
    get_or_create_candidate_document,
    get_or_create_vector_document,
    provider_cache_key,
)
from app.services.storage.documents import find_uploaded_source
from app.services.vector_pipeline.extractor import extract_vector_document

router = APIRouter(tags=["candidates"])


@router.get("/documents/{document_id}/candidates", response_model=CandidateDocument)
async def get_candidate_document(request: Request, document_id: str) -> CandidateDocument:
    settings = request.app.state.settings
    source_path = find_uploaded_source(settings.storage_path, document_id)
    if source_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"document not found: {document_id}",
        )

    try:
        provider = get_ai_provider(settings.ai_provider, settings)
        provider_key = provider_cache_key(provider, settings)
        vector_result = get_or_create_vector_document(
            storage_path=settings.storage_path,
            document_id=document_id,
            source_path=source_path,
            provider_key=provider_key,
            create=lambda: extract_vector_document(
                source_path,
                document_id=document_id,
                ai_provider=provider,
            ),
        )
        candidate_result = get_or_create_candidate_document(
            storage_path=settings.storage_path,
            document_id=document_id,
            source_path=source_path,
            provider_key=provider_key,
            create=lambda: generate_candidate_document(
                vector_result.value,
                source_path=source_path,
            ),
        )
        record_audit_event(
            storage_path=settings.storage_path,
            document_id=document_id,
            event_type="candidates_generated",
            payload={
                **candidate_result.value.summary.model_dump(mode="json"),
                "cache": {
                    "vector_document": vector_result.cache_hit,
                    "candidate_document": candidate_result.cache_hit,
                },
            },
            request=request,
        )
        return candidate_result.value
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to generate candidates: {exc}",
        ) from exc
