from fastapi import APIRouter, HTTPException, Request, status

from app.models.raster import ExtractRequest, RasterPipelineResponse
from app.models.vector import VectorDocument
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.raster_pipeline.pipeline import run_raster_pipeline
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
        vector_document = extract_vector_document(
            source_path,
            document_id=document_id,
            ai_provider=get_ai_provider(settings.ai_provider, settings),
        )
        record_audit_event(
            storage_path=settings.storage_path,
            document_id=document_id,
            event_type="vector_extracted",
            payload=vector_document.summary.model_dump(mode="json"),
            request=request,
        )
        return vector_document
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to extract vector document: {exc}",
        ) from exc


@router.post(
    "/documents/{document_id}/extract",
    response_model=RasterPipelineResponse | VectorDocument,
)
async def extract_document(
    request: Request,
    document_id: str,
    body: ExtractRequest | None = None,
) -> RasterPipelineResponse | VectorDocument:
    settings = request.app.state.settings
    source_path = find_uploaded_source(settings.storage_path, document_id)
    if source_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"document not found: {document_id}",
        )

    try:
        if body and body.force_pipeline == "raster_first":
            raster_response = run_raster_pipeline(
                source_path=source_path,
                document_id=document_id,
                settings=settings,
            )
            record_audit_event(
                storage_path=settings.storage_path,
                document_id=document_id,
                event_type="raster_extracted",
                payload=raster_response.raster_audit.model_dump(mode="json"),
                request=request,
            )
            return raster_response
        vector_document = extract_vector_document(
            source_path,
            document_id=document_id,
            ai_provider=get_ai_provider(settings.ai_provider, settings),
        )
        record_audit_event(
            storage_path=settings.storage_path,
            document_id=document_id,
            event_type="document_extracted",
            payload={"pipeline": "vector_first", **vector_document.summary.model_dump(mode="json")},
            request=request,
        )
        return vector_document
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to extract document: {exc}",
        ) from exc
