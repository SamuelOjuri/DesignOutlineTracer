"""Storage diagnostics containing codes only, never exception text or request data."""
from contextlib import contextmanager
import re

import httpx


def storage_failure_details(stage: str, error: Exception, *, http_status: int | None = None) -> str:
    """Format bounded metadata without serializing messages, URLs, SQL or payloads."""
    if isinstance(error, StorageOperationError):
        return error.details
    stage = stage if re.fullmatch(r"[a-z][a-z0-9_]{0,79}", stage) else "unknown"
    exception_type = type(error).__name__
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,79}", exception_type):
        exception_type = "Exception"
    if http_status is None and isinstance(error, httpx.HTTPStatusError):
        http_status = error.response.status_code
    status = http_status if type(http_status) is int and 100 <= http_status <= 599 else "none"
    sqlstate = getattr(error, "sqlstate", None)
    if not isinstance(sqlstate, str) or not re.fullmatch(r"[0-9A-Z]{5}", sqlstate):
        sqlstate = "none"
    return f"stage={stage} exception_type={exception_type} http_status={status} sqlstate={sqlstate}"


class StorageOperationError(RuntimeError):
    """Carry the first failed stage through nested operations without private text."""

    def __init__(self, stage: str, error: Exception, *, http_status: int | None = None):
        self.details = storage_failure_details(stage, error, http_status=http_status)
        super().__init__("ROI storage operation failed")


@contextmanager
def storage_operation(stage: str, *, http_status: int | None = None):
    try:
        yield
    except StorageOperationError:
        raise
    except Exception as error:
        raise StorageOperationError(stage, error, http_status=http_status) from None
