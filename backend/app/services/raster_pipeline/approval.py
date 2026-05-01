from datetime import UTC, datetime
from pathlib import Path

from app.models.raster import ApprovalRequest, ApprovalResponse


def approval_path(storage_path: Path, document_id: str) -> Path:
    return storage_path / "uploads" / document_id / "approval.json"


def is_approved(storage_path: Path, document_id: str) -> bool:
    return approval_path(storage_path, document_id).exists()


def store_approval(
    *,
    storage_path: Path,
    document_id: str,
    approval: ApprovalRequest,
) -> ApprovalResponse:
    now = datetime.now(UTC).isoformat()
    response = ApprovalResponse(
        document_id=document_id,
        approval_status="approved",
        approved_at=now,
        export_unlocked=True,
    )
    path = approval_path(storage_path, document_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        response.model_dump_json(indent=2),
        encoding="utf-8",
    )
    return response
