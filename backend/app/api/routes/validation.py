from fastapi import APIRouter, HTTPException, Request, status

from app.models.validation import ValidationRequest, ValidationResponse
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.overlays import render_candidate_overlay
from app.services.storage.documents import find_uploaded_source, storage_relative_path, upload_dir
from app.services.storage.validation import load_validation_response, save_validation_response
from app.services.storage.vector_workflow import (
    load_candidate_document,
    load_vector_document,
    save_candidate_document,
    save_vector_document,
)
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
        cached_response = load_validation_response(
            storage_path=settings.storage_path,
            document_id=document_id,
        )
        if cached_response and _candidate_exists(
            candidate_document,
            cached_response.validation.selected_review_candidate_id
            or cached_response.validation.selected_candidate_id,
        ):
            record_audit_event(
                storage_path=settings.storage_path,
                document_id=document_id,
                event_type="candidates_validation_cache_hit",
                payload={
                    "selected_candidate_id": cached_response.validation.selected_candidate_id,
                    "provider": cached_response.validation.provider,
                },
                request=request,
            )
            return cached_response
        overlay_path = render_candidate_overlay(
            source_path=source_path,
            candidate_document=candidate_document,
            output_path=upload_dir(settings.storage_path, document_id) / "candidate_overlay.png",
            top_n=validation_request.top_n,
        )
        validation = provider.validate_candidates(
            candidate_document=candidate_document,
            text_blocks=vector_document.text_blocks,
            overlay_png_path=str(overlay_path),
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
        validation=validation,
    )
    save_validation_response(storage_path=settings.storage_path, response=response)
    record_audit_event(
        storage_path=settings.storage_path,
        document_id=document_id,
        event_type="candidates_validated",
        payload={
            "selected_candidate_id": validation.selected_candidate_id,
            "selected_review_candidate_id": validation.selected_review_candidate_id,
            "selected_auto_export_candidate_id": validation.selected_auto_export_candidate_id,
            "confidence": validation.confidence,
            "review_required": validation.review_required,
            "provider": validation.provider,
            "overlay_png_path": response.overlay_png_path,
        },
        request=request,
    )
    return response


def _candidate_exists(candidate_document: object, candidate_id: str) -> bool:
    return any(
        candidate.id == candidate_id
        for candidate in getattr(candidate_document, "candidate_regions", [])
    )
