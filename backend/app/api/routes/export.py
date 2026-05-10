from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status

from app.models.production import ExportPaths, ExportRequest, ExportResponse
from app.models.validation import ValidationResponse
from app.services.ai.factory import get_ai_provider
from app.services.audit import record_audit_event
from app.services.export.writers import write_exports
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.finalize import build_production_schema
from app.services.geometry.overlays import render_candidate_overlay
from app.services.geometry.quality import QualityGateError, enforce_export_quality_gates
from app.services.raster_pipeline.approval import is_approved
from app.services.raster_pipeline.errors import RasterApprovalRequired
from app.services.raster_pipeline.pipeline import load_raster_production_schema
from app.services.storage.documents import (
    export_dir,
    find_uploaded_source,
    storage_relative_path,
    upload_dir,
)
from app.services.storage.validation import load_validation_response, save_validation_response
from app.services.storage.vector_workflow import (
    load_candidate_document,
    load_vector_document,
    save_candidate_document,
    save_vector_document,
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
            cached_validation = load_validation_response(
                storage_path=settings.storage_path,
                document_id=document_id,
            )
            validation = None
            if cached_validation and _candidate_exists(
                candidate_document,
                cached_validation.validation.selected_review_candidate_id
                or cached_validation.validation.selected_candidate_id,
            ):
                validation = cached_validation.validation
            if validation is None:
                overlay_path = render_candidate_overlay(
                    source_path=source_path,
                    candidate_document=candidate_document,
                    output_path=upload_dir(settings.storage_path, document_id)
                    / "candidate_overlay.png",
                )
                validation = provider.validate_candidates(
                    candidate_document=candidate_document,
                    text_blocks=vector_document.text_blocks,
                    overlay_png_path=str(overlay_path),
                )
                save_validation_response(
                    storage_path=settings.storage_path,
                    response=ValidationResponse(
                        document_id=document_id,
                        source_file=source_path.name,
                        overlay_png_path=storage_relative_path(settings.storage_path, overlay_path),
                        validation=validation,
                    ),
                )
            production_schema = build_production_schema(
                document_id=document_id,
                source_file=source_path.name,
                vector_document=vector_document,
                candidate_document=candidate_document,
                validation=validation,
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


def _candidate_exists(candidate_document: object, candidate_id: str) -> bool:
    return any(
        candidate.id == candidate_id
        for candidate in getattr(candidate_document, "candidate_regions", [])
    )
