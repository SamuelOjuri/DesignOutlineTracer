from pydantic import BaseModel, Field


class ValidationRequest(BaseModel):
    top_n: int = Field(default=5, ge=1, le=10)


class SemanticValidationResult(BaseModel):
    selected_candidate_id: str
    reason: str
    confidence: float = Field(ge=0, le=1)
    review_required: bool
    provider: str
    model: str
    escalation_used: bool = False


class ValidationResponse(BaseModel):
    document_id: str
    source_file: str
    overlay_png_path: str | None
    validation: SemanticValidationResult
