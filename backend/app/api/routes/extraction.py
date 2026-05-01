from fastapi import APIRouter, HTTPException, Request, status

from app.models.vector import VectorDocument
from app.services.ai.factory import get_ai_provider
from app.services.storage.documents import find_uploaded_source
from app.services.vector_pipeline.extractor import extract_vector_document

router = APIRouter(tags=["extraction"])


@router.get("/documents/{document_id}/vector", response_model=VectorDocument)
async def get_vector_document(request: Request, document_id: str) -> VectorDocument:
    settings = request.app.state.settings
    source_path = find_uploaded_source(settings.storage_path, document_id)
    if source_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"document not found: {document_id}",
        )

    try:
        return extract_vector_document(
            source_path,
            document_id=document_id,
            ai_provider=get_ai_provider(settings.ai_provider),
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to extract vector document: {exc}",
        ) from exc
