from pydantic import BaseModel

from app.models.classification import ClassificationResult


class DocumentUploadResponse(BaseModel):
    document_id: str
    original_filename: str
    stored_path: str
    preview_png_path: str | None
    classification: ClassificationResult
