import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import Request

from app.services.storage.documents import upload_dir


def audit_path(storage_path: Path, document_id: str) -> Path:
    return upload_dir(storage_path, document_id) / "audit.json"


def record_audit_event(
    *,
    storage_path: Path,
    document_id: str,
    event_type: str,
    payload: dict[str, Any],
    request: Request | None = None,
) -> None:
    path = audit_path(storage_path, document_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    events = _read_events(path)
    events.append(
        {
            "event_type": event_type,
            "request_id": getattr(getattr(request, "state", None), "request_id", None),
            "created_at": datetime.now(UTC).isoformat(),
            "payload": payload,
        }
    )
    path.write_text(
        json.dumps({"document_id": document_id, "events": events}, indent=2),
        encoding="utf-8",
    )


def _read_events(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    payload = json.loads(path.read_text(encoding="utf-8"))
    events = payload.get("events", [])
    return events if isinstance(events, list) else []
