from PIL import Image

from app.models.raster import OcrHints
from app.services.raster_pipeline.ocr_merge import merge_ocr_blocks
from app.services.raster_pipeline.ocr_provider import MockOcrProvider


def test_mock_ocr_returns_deterministic_text_blocks() -> None:
    provider = MockOcrProvider()
    blocks = provider.extract_text_blocks(
        Image.new("RGB", (2000, 1000), "white"),
        OcrHints(document_id="doc", source_file="sample.pdf", render_dpi=300),
    )

    assert any(block.text == "rwp.1" for block in blocks)
    assert any(block.text_class == "scale_text" for block in blocks)
    assert all(block.bbox_px[2] > block.bbox_px[0] for block in blocks)


def test_ocr_merge_deduplicates_overlapping_text() -> None:
    provider = MockOcrProvider()
    blocks = provider.extract_text_blocks(
        Image.new("RGB", (2000, 1000), "white"),
        OcrHints(document_id="doc", source_file="sample.pdf", render_dpi=300),
    )

    merged = merge_ocr_blocks([blocks[0], blocks[0].model_copy(update={"id": "dup"})])

    assert len(merged) == 1
