from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import fitz
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.main import create_app
from app.services.ai import gemini


@pytest.mark.parametrize("failed_provider", [None, "ocr", "er"])
def test_gemini_extraction_api_budget_cache_and_failure_handling(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failed_provider: str | None
) -> None:
    settings = Settings(
        _env_file=None,
        storage_root=tmp_path / "storage",
        ai_provider="mock",
        allow_live_ai_calls=True,
        google_api_key="test-key",
        raster_render_dpi=72,
        raster_preview_dpi=36,
        raster_ocr_provider="gemini",
        gemini_ocr_model="test-ocr",
        ocr_cache_dir=tmp_path / "ocr",
        ocr_tile_size_px=160,
        ocr_tile_overlap_px=20,
        ocr_max_tiles=2,
        raster_max_tile_pixels=10000,
        segmentation_provider="gemini_er",
        gemini_er_model="test-er",
        gemini_er_max_image_dimension=500,
        gemini_er_cache_dir=tmp_path / "er",
    )
    provider_client = MagicMock()
    provider_client.__enter__.return_value = provider_client

    def generate_content(
        *, model: str, contents: list[object], config: object
    ) -> SimpleNamespace:
        if model == f"test-{failed_provider}":
            raise RuntimeError("remote secret-value")
        if model == "test-ocr":
            image = contents[1]
            assert isinstance(image, Image.Image)
            assert image.width * image.height <= settings.raster_max_tile_pixels
            return SimpleNamespace(
                parsed={
                    "blocks": [
                        {
                            "text": "TAPERED INSULATION",
                            "text_class": "roof_build_up_note",
                            "confidence": 0.9,
                            "box_2d": [100, 100, 200, 200],
                        }
                    ]
                }
            )
        assert model == "test-er"
        return SimpleNamespace(
            parsed={
                "regions": [
                    {
                        "box_2d": [100, 80, 900, 920],
                        "confidence": 0.9,
                    }
                ]
            }
        )

    provider_client.models.generate_content.side_effect = generate_content
    monkeypatch.setattr(gemini, "_create_genai_client", lambda api_key: provider_client)
    with fitz.open() as document:
        document.new_page(width=200, height=150)
        page = document.new_page(width=400, height=300)
        page.draw_rect(fitz.Rect(40, 40, 360, 260), width=2)
        page.insert_text((60, 70), "TAPERED INSULATION")
        pdf_bytes = document.tobytes()

    with TestClient(create_app(settings)) as client:
        upload = client.post(
            "/api/documents", files={"file": ("roof.pdf", pdf_bytes, "application/pdf")}
        )
        assert upload.status_code == 201
        url = f"/api/documents/{upload.json()['document_id']}/extract"
        response = client.post(url, json={"page_index": 1})
        if failed_provider == "ocr":
            assert response.status_code == 422
            assert "Gemini OCR failed for model 'test-ocr'" in response.json()["detail"]
            assert "secret-value" not in response.text
            assert provider_client.models.generate_content.call_count == 1
            return

        assert response.status_code == 200, response.text
        payload = response.json()
        assert payload["render"]["page_index"] == 1
        assert (payload["render"]["width_px"], payload["render"]["height_px"]) == (400, 300)
        assert payload["human_review_status"] == "required"
        assert payload["ocr_audit"]["tile_count"] == 2
        assert payload["ocr_audit"]["live_calls"] == 2
        assert [block["bbox_px"] for block in payload["text_blocks"]] == [
            [30, 30, 60, 60],
            [130, 30, 160, 60],
        ]
        assert payload["text_blocks"][1]["bbox_1000"] == [325, 100, 400, 200]
        assert len({block["id"] for block in payload["text_blocks"]}) == 2
        assert payload["raster_audit"]["segmentation_live_calls"] == 1
        assert payload["raster_audit"]["falcon_live_calls"] == 0
        warning_codes = {warning["code"] for warning in payload["warnings"]}
        assert "OCR_TILING_ADAPTED" in warning_codes
        if failed_provider == "er":
            assert "SEGMENTATION_UNAVAILABLE" in warning_codes
            assert payload["segmentation_audit"]["available"] is False
            assert "secret-value" not in response.text
            assert payload["segmentation_candidates"] == []
            return

        assert payload["segmentation_audit"]["available"] is True
        assert len(payload["segmentation_candidates"]) == 1
        assert payload["segmentation_candidates"][0]["review_required"] is True
        cached_response = client.post(url, json={"page_index": 1})
        assert cached_response.status_code == 200, cached_response.text
        cached_payload = cached_response.json()
        assert cached_payload["ocr_audit"]["live_calls"] == 0
        assert cached_payload["ocr_audit"]["cache_hits"] == 2
        assert cached_payload["raster_audit"]["segmentation_live_calls"] == 0
        assert cached_payload["raster_audit"]["segmentation_cache_hits"] == 1
        assert provider_client.models.generate_content.call_count == 3
