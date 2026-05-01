from PIL import Image

from app.models.raster import SegmentationHints
from app.services.raster_pipeline.segmentation import MockSegmenter, NoopSegmenter


def test_noop_segmenter_returns_no_candidates() -> None:
    segmenter = NoopSegmenter()

    candidates = segmenter.segment(
        Image.new("RGB", (500, 500), "white"),
        prompts=["segment roof"],
        hints=SegmentationHints(document_id="doc", source_file="sample.pdf"),
    )

    assert candidates == []
    assert segmenter.audit().provider == "noop"


def test_mock_segmenter_returns_review_required_candidate() -> None:
    segmenter = MockSegmenter()

    candidates = segmenter.segment(
        Image.new("RGB", (500, 500), "white"),
        prompts=["segment roof"],
        hints=SegmentationHints(document_id="doc", source_file="sample.pdf"),
    )

    assert candidates[0].review_required
    assert candidates[0].source == "falcon_perception_candidate_mask"
    assert candidates[0].provider == "mock"
