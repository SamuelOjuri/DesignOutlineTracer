import asyncio
import base64
from hashlib import sha256
from io import BytesIO
import json
import unittest

import httpx
from google import genai
from google.genai import types
from PIL import Image

from backend.app.config import Settings
from backend.app.errors import RoiError
from backend.app.gemini import GeminiProvider, OUTLINE_SYSTEM_PROMPT, ProviderResult
from backend.app.main import PREFIX, create_app
from backend.app.outline_service import model_schema, parse_model_outline
from test_api import FakeProvider, TOKEN, ROOF
from test_images import image_bytes


POLYGON = {"polygons": [{"points": [
    {"x": 200, "y": 200}, {"x": 800, "y": 200},
    {"x": 800, "y": 800}, {"x": 200, "y": 800},
]}], "roi_too_tight": False}


class OutlineApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0.0
        self.provider = FakeProvider()
        self.provider.result = ProviderResult(json.dumps(POLYGON))
        self.app = create_app(Settings(page_ttl_seconds=10, cache_ttl_seconds=5, session_ttl_seconds=20),
                              self.provider, lambda: self.now)
        self.service = self.app.state.roi_service
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 1234)),
                                       base_url="http://127.0.0.1", headers=TOKEN)
        self.image = image_bytes((1200, 800))
        self.context = dict(document_id="document", file_name="private.pdf", page_id="page", page_index=0,
                            source_image_hash=sha256(self.image).hexdigest(), source_width=1200, source_height=800,
                            render_scale=2, render_rotation=0, render_version="pdfjs-test", pdf_view_box=[0, 0, 600, 400])
        await self.upload()

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.service.close()

    async def upload(self, headers=None):
        return await self.client.post(PREFIX + "/pages", data={"context": json.dumps(self.context)},
                                      files={"image": ("plan.png", self.image, "image/png")}, headers=headers)

    def request(self, **changes):
        return dict(dict(schema_version="outline-1", page_id="page", request_id="outline-request",
                         source_image_hash=self.context["source_image_hash"], roi_revision=1, geometry_revision=0,
                         roi={"id": "roof", "revision": 1, "box_2d": [200, 200, 800, 800]},
                         boundary_policy="inner_parapet", boundary_notes="", vector_segments=[]), **changes)

    async def generate(self, headers=None, **changes):
        return await self.client.post(PREFIX + "/pages/page/outlines", json=self.request(**changes), headers=headers)

    async def test_detailed_crop_source_coordinates_and_provenance(self):
        response = await self.generate(boundary_notes="Use the insulation-side edge.")
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["schema_version"], "outline-1")
        self.assertEqual(result["source_image_hash"], self.context["source_image_hash"])
        self.assertEqual(result["roi_id"], "roof")
        self.assertEqual(result["roi_annotation_revision"], 1)
        self.assertEqual(result["geometry_revision"], 0)
        self.assertEqual(result["run"]["prompt_version"], "roof-outline-v1")
        self.assertEqual(result["run"]["provider_attempts"], 1)
        crop = result["crop"]
        self.assertLess(crop["x"], 240)
        self.assertLess(crop["y"], 160)
        self.assertGreater(crop["x"] + crop["width"], 960)
        with Image.open(BytesIO(self.provider.calls[0][0])) as image:
            self.assertEqual(image.size, (crop["inference_width"], crop["inference_height"]))
        original = result["proposals"][0]["proposed_points"][0]
        self.assertAlmostEqual(original["x"], crop["x"] + crop["width"] * .2)
        self.assertAlmostEqual(original["y"], crop["y"] + crop["height"] * .2)
        self.assertIn("normalized CROP", self.provider.calls[0][1])
        self.assertIn("insulation-side inner face", self.provider.calls[0][1])
        self.assertEqual(self.provider.calls[0][2]["required"], ["polygons", "roi_too_tight"])
        self.assertEqual(result["run"]["settings"]["system_prompt_version"], "outline-system-v1")
        self.assertEqual(result["run"]["settings"]["prompt_hash"],
                         sha256((OUTLINE_SYSTEM_PROMPT + self.provider.calls[0][1]).encode()).hexdigest())

    async def test_idempotency_cache_tracks_policy_notes_vectors_and_revisions(self):
        first = await self.generate()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual((await self.generate()).json(), first.json())
        cached = (await self.generate(request_id="cached")).json()
        self.assertTrue(cached["run"]["cached"])
        self.assertEqual(cached["proposals"], first.json()["proposals"])
        self.assertEqual(cached["request_id"], "cached")
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual((await self.generate(boundary_policy="roof_deck")).status_code, 409)
        cases = [{"boundary_policy": "roof_deck"}, {"boundary_notes": "Keep the left return"},
                 {"roi_revision": 2}, {"geometry_revision": 2},
                 {"roi": {"id": "roof", "revision": 2, "box_2d": [200, 200, 800, 800]}},
                 {"vector_segments": [{"start": {"x": 300, "y": 200}, "end": {"x": 900, "y": 200}}]}]
        for index, changes in enumerate(cases):
            response = await self.generate(request_id=f"variant-{index}", **changes)
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.provider.calls), 1 + len(cases))
        self.now = 6
        await self.generate(request_id="after-cache-expiry")
        self.assertEqual(len(self.provider.calls), 2 + len(cases))

    async def test_owner_hash_path_and_vector_bounds_before_provider_call(self):
        other = {"Authorization": "Bearer " + "b" * 64}
        self.assertEqual((await self.generate(headers=other)).status_code, 404)
        self.assertEqual((await self.generate(source_image_hash="f" * 64)).status_code, 409)
        self.assertEqual((await self.generate(page_id="another-page")).status_code, 409)
        vectors = [{"start": {"x": 1, "y": 1}, "end": {"x": 1201, "y": 799}}]
        self.assertEqual((await self.generate(vector_segments=vectors)).json()["error"]["code"], "invalid_vector_geometry")
        self.assertEqual((await self.generate(roi_revision=True)).status_code, 422)
        self.assertEqual((await self.generate(boundary_policy="guess")).status_code, 422)
        self.assertEqual(self.provider.calls, [])

    async def test_empty_too_tight_and_outside_roi_never_create_artificial_edge(self):
        self.provider.result = ProviderResult('{"polygons":[],"roi_too_tight":false}')
        empty = (await self.generate()).json()
        self.assertEqual(empty["status"], "no_outline")
        self.assertEqual(empty["proposals"], [])
        self.provider.result = ProviderResult('{"polygons":[],"roi_too_tight":true}')
        tight = (await self.generate(request_id="tight")).json()
        # A new identity with otherwise identical settings correctly uses the cached empty result.
        self.assertTrue(tight["run"]["cached"])
        tight = (await self.generate(request_id="tight-new", geometry_revision=1)).json()
        self.assertEqual(tight["status"], "roi_too_tight")
        self.assertEqual(tight["proposals"], [])
        outside = {"polygons": [{"points": [
            {"x": 0, "y": 0}, {"x": 900, "y": 0}, {"x": 900, "y": 900}, {"x": 0, "y": 900},
        ]}], "roi_too_tight": False}
        self.provider.result = ProviderResult(json.dumps(outside))
        clipped = (await self.generate(request_id="outside", geometry_revision=2)).json()
        self.assertEqual(clipped["status"], "roi_too_tight")
        self.assertEqual(clipped["proposals"], [])

    async def test_invalid_and_truncated_output_are_terminal_and_do_not_leak_content(self):
        cases = [ProviderResult("private malformed response"),
                 ProviderResult(json.dumps(POLYGON), "MAX_TOKENS"),
                 ProviderResult('{"polygons":[],"polygons":[],"roi_too_tight":false}'),
                 ProviderResult('{"polygons":[],"roi_too_tight":"false"}'),
                 ProviderResult('{"polygons":[{"points":[{"x":NaN,"y":0}]}],"roi_too_tight":false}')]
        for index, value in enumerate(cases):
            self.provider.result = value
            with self.assertLogs("roi_app.outlines", level="WARNING") as logs:
                response = await self.generate(request_id=f"invalid-{index}")
            self.assertEqual(response.status_code, 502)
            self.assertNotIn("private", response.text + " ".join(logs.output))
            self.assertIn(response.json()["error"]["code"], {"malformed_output", "truncated_output"})
        self.assertEqual(len(self.provider.calls), len(cases))
        self.assertFalse(next(iter(self.service.sessions.values())).pages["page"].outline_cache)

    async def test_shared_concurrency_and_budgets_with_annotation_service(self):
        self.service.settings = Settings(max_concurrent_requests=1, max_calls_per_session=1, max_total_calls=1)
        self.provider.release.clear()
        pending = asyncio.create_task(self.generate())
        await self.provider.started.wait()
        detection = dict(page_id="page", request_id="detection", source_image_hash=self.context["source_image_hash"],
                         task="roof_roi", roi_revision=None, geometry_revision=0)
        crowded = await self.client.post(PREFIX + "/pages/page/detections", json=detection)
        self.assertEqual(crowded.json()["error"]["code"], "concurrency_limit_exceeded")
        self.provider.release.set()
        self.assertEqual((await pending).status_code, 200)
        limited = await self.generate(request_id="limited", geometry_revision=1)
        self.assertEqual(limited.json()["error"]["code"], "call_budget_exceeded")
        detection["request_id"] = "after-outline"
        limited = await self.client.post(PREFIX + "/pages/page/detections", json=detection)
        self.assertEqual(limited.json()["error"]["code"], "call_budget_exceeded")
        self.assertEqual(self.service.total_calls, 1)
        self.assertEqual(self.service.active_calls, 0)

    async def test_concurrent_duplicate_and_delete_cancel_outline_work(self):
        self.provider.release.clear()
        first = asyncio.create_task(self.generate())
        await self.provider.started.wait()
        duplicate = asyncio.create_task(self.generate())
        self.provider.release.set()
        first_response, duplicate_response = await asyncio.gather(first, duplicate)
        self.assertEqual(first_response.json(), duplicate_response.json())
        self.assertEqual(len(self.provider.calls), 1)
        self.provider.release.clear()
        self.provider.started.clear()
        pending = asyncio.create_task(self.generate(request_id="delete-during", geometry_revision=1))
        await self.provider.started.wait()
        await self.client.delete(PREFIX + "/pages/page")
        self.assertEqual((await pending).status_code, 404)
        self.assertTrue(self.provider.cancelled.is_set())
        self.assertEqual(self.service.active_calls, 0)

    async def test_timeout_retry_budget_disabled_and_expiry(self):
        self.provider.ready = False
        self.assertEqual((await self.generate()).json()["error"]["code"], "provider_not_configured")
        self.provider.ready = True
        self.service.settings = Settings(timeout_seconds=.1)
        self.provider.release.clear()
        timeout = await self.generate(request_id="timeout")
        self.assertEqual(timeout.json()["error"]["code"], "provider_timeout")
        self.assertEqual(self.service.active_calls, 0)
        self.provider.release.set()
        self.service.settings = Settings(max_calls_per_session=2)
        self.provider.errors = [RoiError("provider_unavailable", 502, True)]
        budget = await self.generate(request_id="retry-budget")
        self.assertEqual(budget.json()["error"]["code"], "call_budget_exceeded")
        self.now = 11
        self.assertEqual((await self.generate(request_id="expired")).status_code, 404)

    async def test_larger_bounded_vector_request_and_endpoint_request_identity(self):
        segments = [{"start": {"x": 300.123456789, "y": 200.123456789},
                     "end": {"x": 900.123456789, "y": 200.123456789}}] * 1000
        self.assertGreater(len(json.dumps(self.request(vector_segments=segments))), 65536)
        response = await self.generate(vector_segments=segments)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((await self.generate(request_id="oversize", vector_segments=segments * 3)).status_code, 422)
        too_large = await self.client.post(PREFIX + "/pages/page/outlines", content=b"x" * (512 * 1024 + 1))
        self.assertEqual(too_large.status_code, 413)
        self.provider.result = ProviderResult(ROOF)
        detection = dict(page_id="page", request_id="outline-request", source_image_hash=self.context["source_image_hash"],
                         task="roof_roi", roi_revision=None, geometry_revision=0)
        conflicting = await self.client.post(PREFIX + "/pages/page/detections", json=detection)
        self.assertEqual(conflicting.status_code, 409)

    async def test_overview_is_sent_separately_when_provider_supports_context(self):
        calls = []

        async def with_context(image, prompt, schema, overview):
            calls.append((image, prompt, schema, overview))
            return self.provider.result

        self.provider.generate_with_context = with_context
        response = await self.generate()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(calls), 1)
        with Image.open(BytesIO(calls[0][3])) as overview:
            self.assertEqual(overview.size, (1024, 683))
        self.assertNotEqual(calls[0][0], calls[0][3])
        self.assertTrue(response.json()["run"]["settings"]["overview_supplied"])


class OutlineGeminiWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_crop_precedes_context_image_without_changing_schema_or_model_settings(self):
        captured = []

        def respond(request):
            captured.append(json.loads(request.content))
            event = {"candidates": [{"content": {"parts": [{"text": json.dumps(POLYGON)}]}, "finishReason": "STOP"}]}
            return httpx.Response(200, text="data: " + json.dumps(event) + "\n\n",
                                  headers={"content-type": "text/event-stream"})

        client = genai.Client(vertexai=False, api_key="synthetic-not-a-real-key", http_options=types.HttpOptions(
            retry_options=types.HttpRetryOptions(attempts=1),
            async_client_args={"transport": httpx.MockTransport(respond)},
        ))
        provider = GeminiProvider(Settings(allow_live=True, api_key="synthetic-not-a-real-key", structured_output=True), client)
        try:
            result = await provider.generate_with_context(b"crop-image", "Outline the first detailed crop", model_schema(), b"overview-image")
            self.assertEqual(result.text, json.dumps(POLYGON))
            parts = captured[0]["contents"][0]["parts"]
            image_parts = [part["inlineData"] for part in parts if "inlineData" in part]
            self.assertEqual([base64.b64decode(part["data"]) for part in image_parts], [b"crop-image", b"overview-image"])
            self.assertTrue(any("FIRST detailed crop" in part.get("text", "") for part in parts))
            self.assertEqual(captured[0]["generationConfig"]["responseJsonSchema"], model_schema())
            self.assertEqual(captured[0]["generationConfig"]["maxOutputTokens"], 32768)
            system = captured[0]["systemInstruction"]["parts"][0]["text"]
            self.assertEqual(system, OUTLINE_SYSTEM_PROMPT)
            self.assertIn("untrusted task data", system)
            self.assertIn("Return only a JSON object", system)
            self.assertIn('"polygons" and "roi_too_tight"', system)
            self.assertIn("FIRST detailed crop", system)
            self.assertNotIn("Return only a JSON array", system)
            self.assertNotIn("box_2d", system)
        finally:
            await provider.close()


class OutlineParsingTests(unittest.TestCase):
    def test_single_fence_and_fractional_coordinate_precision(self):
        payload = json.loads(json.dumps(POLYGON))
        payload["polygons"][0]["points"][0]["x"] = 200.1234
        result = parse_model_outline("```JSON\r\n" + json.dumps(payload) + "\r\n```", 10000)
        self.assertEqual(result.polygons[0].points[0].x, 200.1234)

    def test_unknown_fields_bool_coordinates_and_inconsistent_status_rejected(self):
        cases = [{**POLYGON, "execute": "not instructions"}, {**POLYGON, "roi_too_tight": True}]
        boolean_point = json.loads(json.dumps(POLYGON))
        boolean_point["polygons"][0]["points"][0]["x"] = True
        cases.append(boolean_point)
        for case in cases:
            with self.subTest(case=case), self.assertRaises(RoiError):
                parse_model_outline(json.dumps(case), 10000)
