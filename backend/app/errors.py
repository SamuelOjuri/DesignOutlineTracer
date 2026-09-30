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


class RoiError(Exception):
    def __init__(self, code: str, status: int = 422, retryable: bool = False, *,
                 diagnostic: OutputDiagnostic | None = None):
        self.code = code
        self.status = status
        self.retryable = retryable
        self.diagnostic = diagnostic
        super().__init__(code)