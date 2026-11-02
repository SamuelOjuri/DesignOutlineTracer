from enum import StrEnum


class OutputDiagnostic(StrEnum):
    STREAM_CANDIDATE_COUNT = "stream_candidate_count"
    STREAM_MISSING_FINISH = "stream_missing_finish"
    STREAM_UNEXPECTED_FINISH = "stream_unexpected_finish"
    EMPTY_TEXT = "empty_text"
    JSON_SYNTAX = "json_syntax"
    JSON_STRUCTURE = "json_structure"
    ANNOTATION_FIELDS = "annotation_fields"
    ANNOTATION_GEOMETRY = "annotation_geometry"
    ANNOTATION_LABEL = "annotation_label"
    ANNOTATION_ASSOCIATION = "annotation_association"
    OUTLINE_FIELDS = "outline_fields"
    OUTLINE_STATUS = "outline_status"
    OUTLET_FIELDS = "outlet_fields"


class RoiError(Exception):
    def __init__(self, code: str, status: int = 422, retryable: bool = False, *,
                 diagnostic: OutputDiagnostic | None = None, detail: str | None = None):
        self.code = code
        self.status = status
        self.retryable = retryable
        self.diagnostic = diagnostic
        # Schema rule names only (never provider text); used for server-side logs.
        self.detail = detail
        super().__init__(code)


def output_category(error: RoiError) -> str:
    return error.diagnostic.value if isinstance(error.diagnostic, OutputDiagnostic) else "unspecified"