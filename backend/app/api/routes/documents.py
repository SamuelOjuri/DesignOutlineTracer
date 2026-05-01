from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status

from app.models.documents import DocumentUploadResponse
from app.services.classifier.pdf_classifier import classify_source
from app.services.storage.documents import (
    new_document_id,
    persist_upload,
    safe_filename,
    storage_relative_path,
    upload_dir,
)
from app.services.storage.previews import render_pdf_preview

router = APIRouter(tags=["documents"])


@router.post(
    "/documents",
    response_model=DocumentUploadResponse,
    status_code=status.HTTP_201_CREATED,
)
async def upload_document(
    request: Request,
    file: Annotated[UploadFile, File(...)],
) -> DocumentUploadResponse:
    if not file.filename:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="filename is required")

    settings = request.app.state.settings
    document_id = new_document_id()
    destination_dir = upload_dir(settings.storage_path, document_id)
    filename = safe_filename(file.filename)
    source_path = destination_dir / filename

    bytes_written = await persist_upload(file, source_path)
    if bytes_written == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="uploaded file is empty",
        )

    try:
        classification = classify_source(source_path, original_filename=filename)
        preview_path = render_pdf_preview(source_path, destination_dir / "preview.png")
    except Exception as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"failed to classify document: {exc}",
        ) from exc

    return DocumentUploadResponse(
        document_id=document_id,
        original_filename=file.filename,
        stored_path=storage_relative_path(settings.storage_path, source_path),
        preview_png_path=(
            storage_relative_path(settings.storage_path, preview_path) if preview_path else None
        ),
        classification=classification,
    )
