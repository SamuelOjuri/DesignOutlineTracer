from fastapi import APIRouter, HTTPException, Request, status

from app.models.candidates import CandidateDocument
from app.services.ai.factory import get_ai_provider
from app.services.geometry.candidates import generate_candidate_document
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
        vector_document = extract_vector_document(
            source_path,
            document_id=document_id,
            ai_provider=get_ai_provider(settings.ai_provider),
        )
        return generate_candidate_document(vector_document)
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to generate candidates: {exc}",
        ) from exc
