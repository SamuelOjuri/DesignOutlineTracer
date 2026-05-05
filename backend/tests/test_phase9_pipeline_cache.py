from pathlib import Path

from app.models.candidates import CandidateDocument, CandidateSummary
from app.models.validation import SemanticValidationResult
from app.models.vector import PageMetadata, VectorDocument, VectorExtractionSummary
from app.services.pipeline_cache import (
    get_or_create_candidate_document,
    get_or_create_validation_result,
    get_or_create_vector_document,
)
from app.services.storage.documents import upload_dir


def test_pipeline_cache_reuses_vector_candidate_and_validation_artifacts(tmp_path: Path) -> None:
    document_id = "doc-cache"
    source_path = upload_dir(tmp_path, document_id) / "source.pdf"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(b"%PDF-1.7\n")
    calls = {"vector": 0, "candidate": 0, "validation": 0}

    def create_vector() -> VectorDocument:
        calls["vector"] += 1
        return _vector_document(document_id, source_path.name)

    def create_candidate() -> CandidateDocument:
        calls["candidate"] += 1
        return _candidate_document(document_id, source_path.name)

    def create_validation() -> SemanticValidationResult:
        calls["validation"] += 1
        return _validation_result()

    first_vector = get_or_create_vector_document(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="gemini:test-model",
        create=create_vector,
    )
    second_vector = get_or_create_vector_document(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="gemini:test-model",
        create=create_vector,
    )
    first_candidate = get_or_create_candidate_document(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="gemini:test-model",
        create=create_candidate,
    )
    second_candidate = get_or_create_candidate_document(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="gemini:test-model",
        create=create_candidate,
    )
    first_validation = get_or_create_validation_result(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="gemini:test-model",
        create=create_validation,
    )
    second_validation = get_or_create_validation_result(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="gemini:test-model",
        create=create_validation,
    )

    assert first_vector.cache_hit is False
    assert second_vector.cache_hit is True
    assert first_candidate.cache_hit is False
    assert second_candidate.cache_hit is True
    assert first_validation.cache_hit is False
    assert second_validation.cache_hit is True
    assert calls == {"vector": 1, "candidate": 1, "validation": 1}
    assert second_vector.value == first_vector.value
    assert second_candidate.value == first_candidate.value
    assert second_validation.value == first_validation.value


def test_pipeline_cache_invalidates_when_provider_changes(tmp_path: Path) -> None:
    document_id = "doc-provider-change"
    source_path = upload_dir(tmp_path, document_id) / "source.pdf"
    source_path.parent.mkdir(parents=True, exist_ok=True)
    source_path.write_bytes(b"%PDF-1.7\n")
    calls = 0

    def create_vector() -> VectorDocument:
        nonlocal calls
        calls += 1
        return _vector_document(document_id, source_path.name)

    mock_result = get_or_create_vector_document(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="mock",
        create=create_vector,
    )
    gemini_result = get_or_create_vector_document(
        storage_path=tmp_path,
        document_id=document_id,
        source_path=source_path,
        provider_key="gemini:test-model",
        create=create_vector,
    )

    assert mock_result.cache_hit is False
    assert gemini_result.cache_hit is False
    assert calls == 2


def _vector_document(document_id: str, source_file: str) -> VectorDocument:
    return VectorDocument(
        document_id=document_id,
        source_file=source_file,
        page_metadata=[
            PageMetadata(
                page_number=1,
                page_width=100.0,
                page_height=100.0,
                rotation=0,
                media_box=[0.0, 0.0, 100.0, 100.0],
                crop_box=[0.0, 0.0, 100.0, 100.0],
            )
        ],
        text_blocks=[],
        classified_text_blocks=[],
        vector_primitives=[],
        sheet_regions=[],
        rooflight_rectangles=[],
        summary=VectorExtractionSummary(
            text_block_count=0,
            classified_text_block_count=0,
            vector_primitive_count=0,
            sheet_region_count=0,
            rwp_label_count=0,
            rwp_labels=[],
            rooflight_rectangle_count=0,
        ),
    )


def _candidate_document(document_id: str, source_file: str) -> CandidateDocument:
    return CandidateDocument(
        document_id=document_id,
        source_file=source_file,
        pipeline_profile="vector",
        candidate_regions=[],
        summary=CandidateSummary(
            candidate_count=0,
            top_candidate_id=None,
            top_candidate_score=None,
            roof_scope_candidate_rank=None,
        ),
    )


def _validation_result() -> SemanticValidationResult:
    return SemanticValidationResult(
        selected_candidate_id="candidate_01",
        reason="cached validation",
        confidence=0.5,
        review_required=True,
        provider="gemini",
        model="gemini-3-flash-preview",
    )
