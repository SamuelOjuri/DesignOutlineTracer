import json
import unittest

import httpx
from google import genai
from google.genai import types

from backend.roi_app.config import Settings
from backend.roi_app.errors import OutputDiagnostic, RoiError
from backend.roi_app.gemini import GeminiProvider, make_prompt, response_schema


class GeminiTests(unittest.IsolatedAsyncioTestCase):
    async def make_call(self, payload=None, status=200, structured=False, max_bytes=262144, chunks=None):
        captured = []

        def respond(request):
            captured.append(request)
            if status != 200:
                return httpx.Response(status, json={"error": {"code": status, "message": "private provider detail"}})
            data = "".join("data: " + json.dumps(chunk) + "\n\n" for chunk in (chunks if chunks is not None else [payload]))
            return httpx.Response(200, text=data, headers={"content-type": "text/event-stream"})

        client = genai.Client(vertexai=False, api_key="synthetic-not-a-real-key", http_options=types.HttpOptions(
            retry_options=types.HttpRetryOptions(attempts=1),
            async_client_args={"transport": httpx.MockTransport(respond)},
        ))
        provider = GeminiProvider(Settings(allow_live=True, api_key="synthetic-not-a-real-key",
                                          structured_output=structured, max_response_bytes=max_bytes), client)
        try:
            result = await provider.generate(b"synthetic-image", make_prompt("roof_roi", [], 25),
                                             response_schema("roof_roi", [], 25))
            return result, captured
        finally:
            await provider.close()

    async def test_roof_request_preserves_notebook_scope_instructions(self):
        payload = {"candidates": [{"content": {"parts": [{"text": "[]"}]}, "finishReason": "STOP"}]}
        _, captured = await self.make_call(payload)
        request = json.loads(captured[0].content)
        prompt = request["contents"][0]["parts"][0]["text"]
        self.assertIn("Annotate the proposed flat roof / tapered insulation scope area(s) in the roof plan", prompt)
        self.assertIn("Do not return a box for the whole drawing sheet or the whole roof plan.", prompt)
        self.assertIn("Return only the specific proposed flat roof / tapered insulation scope area(s).", prompt)
        self.assertIn("Do not merge disconnected scopes.", prompt)
        self.assertIn("Return at most 25 objects.", prompt)
        self.assertIn("untrusted task data", request["systemInstruction"]["parts"][0]["text"])
        self.assertIn("[ymin, xmin, ymax, xmax]", request["systemInstruction"]["parts"][0]["text"])

    async def test_sdk_wire_contract_and_optional_structured_output(self):
        payload = {"candidates": [{"content": {"parts": [{"text": "[]"}]}, "finishReason": "STOP"}]}
        for structured in (False, True):
            result, captured = await self.make_call(payload, structured=structured)
            self.assertEqual(result.text, "[]")
            self.assertEqual(len(captured), 1)
            self.assertIn("gemini-3.6-flash", str(captured[0].url))
            config = json.loads(captured[0].content)["generationConfig"]
            self.assertEqual(config["temperature"], 0.5)
            self.assertNotIn("thinkingConfig", config)
            self.assertEqual("responseJsonSchema" in config, structured)

    async def test_safe_errors_no_sdk_retries(self):
        for status, code, retryable in ((400, "unsupported_request_or_settings", False),
                                        (401, "authentication_failed", False), (403, "permission_denied", False),
                                        (404, "model_unavailable", False), (429, "rate_limited", True),
                                        (503, "provider_unavailable", True)):
            with self.subTest(status=status), self.assertRaises(RoiError) as raised:
                await self.make_call(status=status)
            self.assertEqual(raised.exception.code, code)
            self.assertEqual(raised.exception.retryable, retryable)
            self.assertNotIn("private", str(raised.exception))

    async def test_refusal_and_size_limit(self):
        for payload, maximum, code in (
            ({"promptFeedback": {"blockReason": "SAFETY"}}, 1024, "provider_refusal"),
            ({"candidates": [{"finishReason": "SAFETY"}]}, 1024, "provider_refusal"),
            ({"candidates": [{"content": {"parts": [{"text": "large"}]}, "finishReason": "STOP"}]}, 10, "response_too_large"),
        ):
            with self.subTest(code=code), self.assertRaises(RoiError) as raised:
                await self.make_call(payload, max_bytes=maximum)
            self.assertEqual(raised.exception.code, code)

    async def test_disabled_provider_never_constructs_client(self):
        provider = GeminiProvider(Settings())
        self.assertFalse(provider.ready)
        with self.assertRaises(RoiError):
            await provider.generate(b"", "", {})
        self.assertIsNone(provider.client)

    async def test_stream_diagnostics_distinguish_completion_and_candidate_failures(self):
        for payload, category in (
            ({"candidates": [{"content": {"parts": [{"text": "private text"}]}}]}, OutputDiagnostic.STREAM_MISSING_FINISH),
            ({"candidates": [{"finishReason": "OTHER"}]}, OutputDiagnostic.STREAM_UNEXPECTED_FINISH),
            ({"candidates": [{"index": 0}, {"index": 1}]}, OutputDiagnostic.STREAM_CANDIDATE_COUNT),
        ):
            with self.subTest(category=category), self.assertRaises(RoiError) as raised:
                await self.make_call(payload)
            self.assertEqual(raised.exception.diagnostic, category)
            self.assertEqual(str(raised.exception), "malformed_output")
            self.assertFalse(raised.exception.retryable)

    async def test_stream_joins_json_and_retains_finish_through_usage_chunks(self):
        chunks = [
            {"candidates": [{"content": {"parts": [{"text": "private reasoning", "thought": True}]}}]},
            {"candidates": [{"content": {"parts": [{"text": "```json\r\n["}]}}]},
            {"candidates": [{"content": {"parts": [{"text": "]\r\n```"}]}, "finishReason": "STOP"}]},
            {"usageMetadata": {"totalTokenCount": 10}},
        ]
        result, captured = await self.make_call(chunks=chunks)
        self.assertEqual(result.text, "```json\r\n[]\r\n```")
        self.assertEqual(result.finish_reason, "STOP")
        self.assertEqual(len(captured), 1)