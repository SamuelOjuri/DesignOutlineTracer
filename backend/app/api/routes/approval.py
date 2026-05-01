from fastapi import APIRouter, HTTPException, Request, status

from app.models.raster import ApprovalRequest, ApprovalResponse
from app.services.raster_pipeline.approval import store_approval
from app.services.storage.documents import find_uploaded_source

router = APIRouter(tags=["approval"])


@router.post("/documents/{document_id}/approve", response_model=ApprovalResponse)
async def approve_document(
    request: Request,
    document_id: str,
    body: ApprovalRequest,
) -> ApprovalResponse:
    settings = request.app.state.settings
    if find_uploaded_source(settings.storage_path, document_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"document not found: {document_id}",
        )
    return store_approval(
        storage_path=settings.storage_path,
        document_id=document_id,
        approval=body,
    )
