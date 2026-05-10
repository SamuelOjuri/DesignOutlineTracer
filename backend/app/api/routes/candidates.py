from fastapi import APIRouter, HTTPException, Request, status

from app.models.candidates import CandidateDocument
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.geometry.candidates import generate_candidate_document
from app.services.storage.documents import find_uploaded_source
from app.services.storage.vector_workflow import (
    load_candidate_document,
    load_vector_document,
    save_candidate_document,
    save_vector_document,
)
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
        vector_document = load_vector_document(
            storage_path=settings.storage_path,
            document_id=document_id,
            source_path=source_path,
        )
        if vector_document is None:
            vector_document = extract_vector_document(
                source_path,
                document_id=document_id,
                ai_provider=provider,
            )
            save_vector_document(
                storage_path=settings.storage_path,
                source_path=source_path,
                vector_document=vector_document,
            )
        candidate_document = load_candidate_document(
            storage_path=settings.storage_path,
            document_id=document_id,
            source_path=source_path,
        )
        if candidate_document is None:
            candidate_document = generate_candidate_document(
                vector_document,
                source_path=source_path,
            )
            save_candidate_document(
                storage_path=settings.storage_path,
                source_path=source_path,
                candidate_document=candidate_document,
            )
        record_audit_event(
            storage_path=settings.storage_path,
            document_id=document_id,
            event_type="candidates_generated",
            payload=candidate_document.summary.model_dump(mode="json"),
            request=request,
        )
        return candidate_document
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to generate candidates: {exc}",
        ) from exc
