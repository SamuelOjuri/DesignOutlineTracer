import ast
from pathlib import Path
import unittest
from unittest.mock import patch

from google import genai
from google.oauth2.credentials import Credentials
from google.genai import types
import httpx

from backend.roi_reference.contracts import ReferenceError
from backend.roi_reference.provider import create_client, generate
from backend.roi_reference.runner import ROOT, interpret_response, read_config
from test_runner import request_for_test


class ProviderTests(unittest.TestCase):
    def test_credentials_and_endpoint_configuration_are_explicit(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaisesRegex(ReferenceError, "missing_google_api_key"):
                create_client("developer", read_config())
        with patch.dict("os.environ", {"GOOGLE_API_KEY": "synthetic", "GOOGLE_CLOUD_PROJECT": "test-project",
                                       "GOOGLE_CLOUD_LOCATION": "global"}, clear=True):
            with patch("backend.roi_reference.provider.genai.Client") as factory:
                create_client("developer", read_config())
                self.assertFalse(factory.call_args.kwargs["vertexai"])
                self.assertEqual(factory.call_args.kwargs["http_options"].api_version, "v1beta")
                create_client("vertex", read_config())
                self.assertTrue(factory.call_args.kwargs["vertexai"])
                self.assertEqual(factory.call_args.kwargs["http_options"].api_version, "v1")
                self.assertNotIn("api_key", factory.call_args.kwargs)

    def test_sdk_success_on_both_provider_paths_and_usage_provenance(self):
        def handle(request):
            self.assertIn("gemini-3.6-flash:generateContent", request.url.path)
            return httpx.Response(200, json={
                "candidates": [{"finishReason": "STOP", "content": {"parts": [{"text": "[]"}]}}],
                "modelVersion": "gemini-3.6-flash", "responseId": "synthetic-response",
                "usageMetadata": {"totalTokenCount": 20},
            })

        for vertex in (False, True):
            with self.subTest(vertex=vertex):
                with httpx.Client(transport=httpx.MockTransport(handle)) as transport:
                    credentials = {"credentials": Credentials(token="synthetic-token"), "project": "test-project", "location": "global"} if vertex else {"api_key": "synthetic"}
                    with genai.Client(vertexai=vertex, **credentials, http_options=types.HttpOptions(
                        api_version="v1" if vertex else "v1beta", httpx_client=transport,
                        retry_options=types.HttpRetryOptions(attempts=1)
                    )) as client:
                        request = request_for_test(profile="json")
                        result = interpret_response(generate(client, request, b"image"), request)
                        self.assertEqual(result["status"], "no_detections")
                        self.assertEqual(result["usage"]["total_token_count"], 20)
                        self.assertEqual(result["provider_response_id"], "synthetic-response")

    def test_timeout_is_not_an_empty_detection(self):
        def handle(_request):
            raise httpx.ReadTimeout("private-timeout-detail")

        with httpx.Client(transport=httpx.MockTransport(handle)) as transport:
            with genai.Client(vertexai=False, api_key="synthetic", http_options=types.HttpOptions(
                httpx_client=transport, retry_options=types.HttpRetryOptions(attempts=1)
            )) as client:
                with self.assertRaisesRegex(ReferenceError, "^provider_timeout$"):
                    generate(client, request_for_test(), b"image")

    def test_reference_code_has_no_legacy_or_colab_imports(self):
        for path in ROOT.glob("*.py"):
            for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                modules = []
                if isinstance(node, ast.Import):
                    modules = [alias.name for alias in node.names]
                elif isinstance(node, ast.ImportFrom):
                    modules = [node.module or ""]
                for module in modules:
                    self.assertFalse(module == "app" or module.startswith(("app.", "backend.app", "google.colab")), Path(path).name)