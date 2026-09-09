from fastapi import APIRouter, HTTPException, Request, status

from app.models.raster import ExtractRequest, RasterPipelineResponse
from app.models.vector import VectorDocument
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.classifier.pdf_classifier import classify_source
from app.services.pipeline_cache import get_or_create_vector_document, provider_cache_key
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
        provider = get_ai_provider(settings.ai_provider, settings)
        vector_result = get_or_create_vector_document(
            storage_path=settings.storage_path,
            document_id=document_id,
            source_path=source_path,
            provider_key=provider_cache_key(provider, settings),
            create=lambda: extract_vector_document(
                source_path,
                document_id=document_id,
                ai_provider=provider,
            ),
        )
        record_audit_event(
            storage_path=settings.storage_path,
            document_id=document_id,
            event_type="vector_extracted",
            payload={
                **vector_result.value.summary.model_dump(mode="json"),
                "cache": {"vector_document": vector_result.cache_hit},
            },
            request=request,
        )
        return vector_result.value
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
        forced_pipeline = body.force_pipeline if body else None
        classification = classify_source(source_path, original_filename=source_path.name)
        should_run_raster = forced_pipeline == "raster_first" or (
            forced_pipeline is None and classification.recommended_pipeline != "cad_first"
        )
        if should_run_raster:
            raster_response = run_raster_pipeline(
                source_path=source_path,
                document_id=document_id,
                settings=settings,
                page_index=body.page_index if body else 0,
            )
            record_audit_event(
                storage_path=settings.storage_path,
                document_id=document_id,
                event_type="raster_extracted",
                payload={
                    "classification": classification.model_dump(mode="json"),
                    "page_index": raster_response.render.page_index,
                    **raster_response.raster_audit.model_dump(mode="json"),
                },
                request=request,
            )
            return raster_response
        if forced_pipeline is None and classification.recommended_pipeline == "cad_first":
            raise ValueError("CAD-first extraction is not implemented yet for DWG/DXF uploads")
        provider = get_ai_provider(settings.ai_provider, settings)
        vector_result = get_or_create_vector_document(
            storage_path=settings.storage_path,
            document_id=document_id,
            source_path=source_path,
            provider_key=provider_cache_key(provider, settings),
            create=lambda: extract_vector_document(
                source_path,
                document_id=document_id,
                ai_provider=provider,
            ),
        )
        record_audit_event(
            storage_path=settings.storage_path,
            document_id=document_id,
            event_type="document_extracted",
            payload={
                "pipeline": "vector_first",
                "classification": classification.model_dump(mode="json"),
                **vector_result.value.summary.model_dump(mode="json"),
                "cache": {"vector_document": vector_result.cache_hit},
            },
            request=request,
        )
        return vector_result.value
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to extract document: {exc}",
        ) from exc
