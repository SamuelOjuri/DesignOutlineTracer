from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import httpx
from google import genai
from google.genai import types
from PIL import Image

from backend.roi_reference.contracts import MODEL, ReferenceError
from backend.roi_reference.images import PreparedImage
from backend.roi_reference.provider import generate
from backend.roi_reference.runner import build_request, interpret_response, run_reference


OPTIONS = {"task": "roof_roi", "profile": "reference", "case_id": "synthetic-test",
           "input_variant": "synthetic", "provider": "developer", "max_output_tokens": 1024}


def request_for_test(**overrides):
    return build_request(PreparedImage(b"image", "hash", 200, 100, 200, 100), **(OPTIONS | overrides))


def raw_response(text="[]", finish="STOP"):
    return {"candidates": [{"finish_reason": finish, "content": {"parts": [{"text": text}]}}]}


class RunnerTests(unittest.TestCase):
    def test_reference_settings_and_explicit_experiments(self):
        request = request_for_test()
        self.assertEqual(request["model"], MODEL)
        config = request["generation_config"]
        self.assertEqual(config["temperature"], 0.5)
        self.assertNotIn("thinking_config", config)
        self.assertNotIn("response_mime_type", config)
        self.assertTrue(request["prompt"].startswith("\nAnnotate the proposed flat roof"))
        structured = request_for_test(profile="json-minimal")["generation_config"]
        self.assertEqual(structured["response_mime_type"], "application/json")
        self.assertEqual(structured["thinking_config"], {"thinking_level": "MINIMAL"})
        types.GenerateContentConfig(**structured)

    def test_valid_empty_refusal_and_partial_are_distinct(self):
        request = request_for_test()
        self.assertEqual(interpret_response(raw_response(), request)["status"], "no_detections")
        self.assertEqual(interpret_response(raw_response(finish="MAX_TOKENS"), request)["status"], "partial")
        for raw in (raw_response(finish="SAFETY"), {"prompt_feedback": {"block_reason": "SAFETY"}}):
            with self.assertRaises(ReferenceError):
                interpret_response(raw, request)
        with self.assertRaisesRegex(ReferenceError, "truncated_output"):
            interpret_response(raw_response("[", "MAX_TOKENS"), request)
        records = [{"label": "Synthetic roof", "box_2d": [0, 0, 10, 10]}] * 25
        result = interpret_response(raw_response(json.dumps(records)), request)
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len({record["id"] for record in result["annotations"]}), 25)

    def test_parents_are_image_bound_and_required(self):
        parents = {"source_sha256": "hash", "revision": 1,
                   "rois": [{"id": "roi-1", "box_2d": [0, 0, 500, 500]}]}
        request = request_for_test(task="penetration", profile="json", parents=parents)
        self.assertIn('"roi-1"', request["prompt"])
        with self.assertRaisesRegex(ReferenceError, "parent_image_mismatch"):
            request_for_test(task="penetration", profile="json", parents=parents | {"source_sha256": "other"})
        with self.assertRaises(ReferenceError):
            request_for_test(task="penetration", profile="json")

    def test_live_opt_in_before_file_or_provider_access(self):
        with patch("backend.roi_reference.runner.prepare_image") as prepare:
            with self.assertRaisesRegex(ReferenceError, "live_run_requires_consent"):
                run_reference(Path("missing"), **OPTIONS)
            prepare.assert_not_called()

    def test_artifacts_preserve_exact_sent_image_and_invalid_response(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "source.png"
            Image.new("RGB", (200, 100), "white").save(image)
            with patch("backend.roi_reference.provider.create_client"), patch(
                "backend.roi_reference.provider.generate", return_value=raw_response("[bad")
            ) as provider:
                directory, result = run_reference(
                    image, allow_live=True, max_calls=1, output_dir=root / "runs", **OPTIONS
                )
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["error"], "invalid_json")
            self.assertEqual((directory / "response.txt").read_text(), "[bad")
            sent_image = provider.call_args.args[2]
            self.assertEqual(sent_image, (directory / "inference.png").read_bytes())
            request = json.loads((directory / "request.json").read_text())
            self.assertEqual(request["image"]["inference_sha256"], sha256(sent_image).hexdigest())
            self.assertEqual(provider.call_count, 1)

    def test_offline_prepare_never_creates_client(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            image = root / "source.png"
            Image.new("RGB", (20, 10)).save(image)
            with patch("backend.roi_reference.provider.create_client") as client:
                _, result = run_reference(image, prepare_only=True, output_dir=root / "runs", **OPTIONS)
                client.assert_not_called()
            self.assertEqual(result["status"], "prepared")
            self.assertEqual(result["attempted_calls"], 0)

    def test_sdk_serialization_and_no_automatic_retries(self):
        requests = []

        def handle(request):
            requests.append(request)
            return httpx.Response(503, json={"error": {"code": 503, "message": "private-provider-text"}})

        with httpx.Client(transport=httpx.MockTransport(handle)) as transport:
            with genai.Client(
                vertexai=False, api_key="synthetic-key",
                http_options=types.HttpOptions(
                    httpx_client=transport, retry_options=types.HttpRetryOptions(attempts=1), timeout=60000,
                ),
            ) as client:
                with self.assertRaisesRegex(ReferenceError, "^provider_unavailable$"):
                    generate(client, request_for_test(profile="json-minimal"), b"image")
        self.assertEqual(len(requests), 1)
        self.assertIn(MODEL, requests[0].url.path)
        body = json.loads(requests[0].content)
        self.assertEqual(body["generationConfig"]["thinkingConfig"], {"thinking_level": "MINIMAL"})
        self.assertEqual(body["generationConfig"]["responseMimeType"], "application/json")

    def test_provider_errors_are_sanitized(self):
        for status, expected in ((400, "unsupported_request_or_settings"), (401, "authentication_failed"),
                                 (403, "permission_denied"), (404, "model_unavailable"), (429, "rate_limited")):
            with self.subTest(status=status):
                with httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(
                    status, json={"error": {"code": status, "message": "private-provider-text"}}
                ))) as transport:
                    with genai.Client(vertexai=False, api_key="synthetic-key", http_options=types.HttpOptions(
                        httpx_client=transport, retry_options=types.HttpRetryOptions(attempts=1)
                    )) as client:
                        with self.assertRaisesRegex(ReferenceError, f"^{expected}$"):
                            generate(client, request_for_test(), b"image")