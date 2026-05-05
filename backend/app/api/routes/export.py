from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status

from app.models.production import ExportPaths, ExportRequest, ExportResponse
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.export.writers import write_exports
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.finalize import build_production_schema
from app.services.geometry.quality import QualityGateError, enforce_export_quality_gates
from app.services.pipeline_cache import (
    get_or_create_candidate_document,
    get_or_create_validation_result,
    get_or_create_vector_document,
    provider_cache_key,
)
from app.services.raster_pipeline.approval import is_approved
from app.services.raster_pipeline.errors import RasterApprovalRequired
from app.services.raster_pipeline.pipeline import load_raster_production_schema
from app.services.storage.documents import (
    export_dir,
    find_uploaded_source,
    storage_relative_path,
)
from app.services.vector_pipeline.extractor import extract_vector_document

router = APIRouter(tags=["export"])


@router.post("/documents/{document_id}/export", response_model=ExportResponse)
async def export_document(
    request: Request,
    document_id: str,
    body: ExportRequest | None = None,
) -> ExportResponse:
    settings = request.app.state.settings
    export_request = body or ExportRequest()
    source_path = find_uploaded_source(settings.storage_path, document_id)
    if source_path is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"document not found: {document_id}",
        )

    try:
        cache_payload: dict[str, bool | None] = {
            "vector_document": None,
            "candidate_document": None,
            "semantic_validation": None,
        }
        if export_request.pipeline == "raster":
            approved = is_approved(settings.storage_path, document_id)
            if "dxf" in export_request.formats and not approved:
                raise RasterApprovalRequired("Raster-derived DXF export requires review approval")
            production_schema = load_raster_production_schema(settings.storage_path, document_id)
            if production_schema is None:
                raise ValueError("Raster pipeline has not been run for this document")
            if approved:
                production_schema.quality_checks.human_review_status = "approved"
                production_schema.target_area.review_required = False
        else:
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
            validation_result = get_or_create_validation_result(
                storage_path=settings.storage_path,
                document_id=document_id,
                source_path=source_path,
                provider_key=provider_key,
                create=lambda: provider.validate_candidates(
                    candidate_document=candidate_result.value,
                    text_blocks=vector_result.value.text_blocks,
                    overlay_png_path=None,
                ),
            )
            cache_payload = {
                "vector_document": vector_result.cache_hit,
                "candidate_document": candidate_result.cache_hit,
                "semantic_validation": validation_result.cache_hit,
            }
            production_schema = build_production_schema(
                document_id=document_id,
                source_file=source_path.name,
                vector_document=vector_result.value,
                candidate_document=candidate_result.value,
                validation=validation_result.value,
                source_path=source_path,
            )
        enforce_export_quality_gates(
            production_schema=production_schema,
            requested_formats=export_request.formats,
        )
        output_dir = export_dir(settings.storage_path, document_id)
        written = write_exports(
            production_schema=production_schema,
            export_directory=output_dir,
            formats=export_request.formats,
        )
    except Exception as exc:
        if isinstance(exc, RasterApprovalRequired):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        if isinstance(exc, QualityGateError):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to export document: {exc}",
        ) from exc

    relative_exports = _relative_export_paths(settings.storage_path, output_dir, written)
    production_schema.exports = relative_exports
    record_audit_event(
        storage_path=settings.storage_path,
        document_id=document_id,
        event_type="document_exported",
        payload={
            "pipeline": export_request.pipeline,
            "formats": export_request.formats,
            "exports": relative_exports.model_dump(mode="json"),
            "quality_checks": production_schema.quality_checks.model_dump(mode="json"),
            "cache": cache_payload,
        },
        request=request,
    )
    return ExportResponse(
        document_id=document_id,
        production_schema=production_schema,
        exports=relative_exports,
    )


def _relative_export_paths(storage_path: Path, output_dir: Path, paths: ExportPaths) -> ExportPaths:
    return ExportPaths(
        dxf=_relative_path(storage_path, output_dir, paths.dxf),
        svg=_relative_path(storage_path, output_dir, paths.svg),
        geojson=_relative_path(storage_path, output_dir, paths.geojson),
        mask_png=_relative_path(storage_path, output_dir, paths.mask_png),
        metadata_json=_relative_path(storage_path, output_dir, paths.metadata_json),
    )


def _relative_path(storage_path: Path, output_dir: Path, filename: str | None) -> str | None:
    if filename is None:
        return None
    return storage_relative_path(storage_path, output_dir / filename)
