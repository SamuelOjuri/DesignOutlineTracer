from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status

from app.models.production import ExportPaths, ExportRequest, ExportResponse
from app.services.ai.factory import get_ai_provider
from app.services.export.writers import write_exports
from app.services.geometry.candidates import generate_candidate_document
from app.services.geometry.finalize import build_production_schema
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
        provider = get_ai_provider(settings.ai_provider, settings)
        vector_document = extract_vector_document(
            source_path,
            document_id=document_id,
            ai_provider=provider,
        )
        candidate_document = generate_candidate_document(vector_document)
        validation = provider.validate_candidates(
            candidate_document=candidate_document,
            text_blocks=vector_document.text_blocks,
            overlay_png_path=None,
        )
        production_schema = build_production_schema(
            document_id=document_id,
            source_file=source_path.name,
            vector_document=vector_document,
            candidate_document=candidate_document,
            validation=validation,
        )
        output_dir = export_dir(settings.storage_path, document_id)
        written = write_exports(
            production_schema=production_schema,
            export_directory=output_dir,
            formats=export_request.formats,
        )
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to export document: {exc}",
        ) from exc

    relative_exports = _relative_export_paths(settings.storage_path, output_dir, written)
    production_schema.exports = relative_exports
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
