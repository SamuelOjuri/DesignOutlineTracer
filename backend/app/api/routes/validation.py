from fastapi import APIRouter, HTTPException, Request, status

from app.models.validation import ValidationRequest, ValidationResponse
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.overlays import render_candidate_overlay
from app.services.pipeline_cache import (
    get_or_create_candidate_document,
    get_or_create_validation_result,
    get_or_create_vector_document,
    provider_cache_key,
)
from app.services.storage.documents import find_uploaded_source, storage_relative_path, upload_dir
from app.services.vector_pipeline.extractor import extract_vector_document

router = APIRouter(tags=["validation"])


@router.post("/documents/{document_id}/validate", response_model=ValidationResponse)
async def validate_document_candidates(
    request: Request,
    document_id: str,
    body: ValidationRequest | None = None,
) -> ValidationResponse:
    settings = request.app.state.settings
    validation_request = body or ValidationRequest()
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
        validation_overlay_path = render_candidate_overlay(
            source_path=source_path,
            candidate_document=candidate_result.value,
            output_path=upload_dir(settings.storage_path, document_id)
            / "candidate_overlay_context.png",
            top_n=validation_request.top_n,
        )
        validation_result = get_or_create_validation_result(
            storage_path=settings.storage_path,
            document_id=document_id,
            source_path=source_path,
            provider_key=provider_key,
            create=lambda: provider.validate_candidates(
                candidate_document=candidate_result.value,
                text_blocks=vector_result.value.text_blocks,
                overlay_png_path=str(validation_overlay_path),
            ),
        )
        overlay_path = render_candidate_overlay(
            source_path=source_path,
            candidate_document=candidate_result.value,
            output_path=upload_dir(settings.storage_path, document_id) / "candidate_overlay.png",
            top_n=validation_request.top_n,
            selected_candidate_id=validation_result.value.selected_candidate_id,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to validate candidates: {exc}",
        ) from exc

    response = ValidationResponse(
        document_id=document_id,
        source_file=source_path.name,
        overlay_png_path=storage_relative_path(settings.storage_path, overlay_path),
        validation=validation_result.value,
    )
    record_audit_event(
        storage_path=settings.storage_path,
        document_id=document_id,
        event_type="candidates_validated",
        payload={
            "selected_candidate_id": validation_result.value.selected_candidate_id,
            "confidence": validation_result.value.confidence,
            "review_required": validation_result.value.review_required,
            "provider": validation_result.value.provider,
            "overlay_png_path": response.overlay_png_path,
            "cache": {
                "vector_document": vector_result.cache_hit,
                "candidate_document": candidate_result.cache_hit,
                "semantic_validation": validation_result.cache_hit,
            },
        },
        request=request,
    )
    return response
