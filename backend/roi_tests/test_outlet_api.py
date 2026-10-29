import asyncio
import base64
from copy import deepcopy
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
from backend.app.gemini import GeminiProvider, OUTLET_SYSTEM_PROMPT, ProviderResult
from backend.app.main import PREFIX, create_app
from backend.app.outlet_geometry import MAX_CROPS, _overlaps_polygon, plan_crops
from backend.app.outlet_models import OutletInput, ScopePolygon
from backend.app.outlet_service import model_schema, parse_outlets
from test_api import FakeProvider, TOKEN
from test_images import image_bytes


def rectangle(left, top, right, bottom):
    return [{"x": left, "y": top}, {"x": right, "y": top},
            {"x": right, "y": bottom}, {"x": left, "y": bottom}]


def inlet(x=500, y=500, **changes):
    return {"label": "Rainwater gully", "subtype": "internal_outlet",
            "box_2d": [y - 5, x - 5, y + 5, x + 5], "anchor": {"x": x, "y": y},
            "evidence": "Gully symbol with rainwater inlet label.", **changes}


class OutletApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0.0
        self.provider = FakeProvider()
        self.provider.result = ProviderResult(json.dumps([inlet()]))
        self.app = create_app(Settings(page_ttl_seconds=10, cache_ttl_seconds=5, session_ttl_seconds=20),
                              self.provider, lambda: self.now)
        self.service = self.app.state.roi_service
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 1234)),
                                       base_url="http://127.0.0.1", headers=TOKEN)
        self.image = image_bytes((1200, 800))
        self.context = dict(document_id="document", file_name="private.pdf", page_id="page", page_index=0,
                            source_image_hash=sha256(self.image).hexdigest(), source_width=1200, source_height=800,
                            render_scale=2, render_rotation=270, render_version="pdfjs-test", pdf_view_box=[0, 0, 600, 400])
        self.assertEqual((await self.client.post(PREFIX + "/pages", data={"context": json.dumps(self.context)},
                                                 files={"image": ("plan.png", self.image, "image/png")})).status_code, 200)

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.service.close()

    def request(self, **changes):
        return dict(dict(contract_version="outlet-1", page_id="page", request_id="outlet-request",
                         source_image_hash=self.context["source_image_hash"], roi_revision=1, geometry_revision=0,
                         scope_signature="scope-v1",
                         accepted_rois=[{"id": "roof", "revision": 1, "box_2d": [100, 100, 900, 900]}],
                         scopes=[{"roi_id": "roof", "outline_id": "outline", "polygons": [
                             {"outer": rectangle(240, 160, 960, 640), "holes": []}]}]), **changes)

    async def generate(self, headers=None, **changes):
        return await self.client.post(PREFIX + "/pages/page/outlets", json=self.request(**changes), headers=headers)

    async def test_precise_anchor_crop_mapping_and_symbol_evidence(self):
        self.provider.result = ProviderResult(json.dumps([inlet(450, 400)]))
        response = await self.generate()
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["contract_version"], "outlet-1")
        self.assertEqual(data["scope_signature"], "scope-v1")
        self.assertEqual(data["status"], "complete")
        candidate = data["annotations"][0]
        crop = data["run"]["crops"][0]
        self.assertLess(crop["x"], 240)
        self.assertLess(crop["y"], 160)
        self.assertAlmostEqual(candidate["anchor"]["x"], crop["x"] + crop["width"] * .45)
        self.assertAlmostEqual(candidate["anchor"]["y"], crop["y"] + crop["height"] * .4)
        self.assertEqual(candidate["proposed_anchor"], candidate["anchor"])
        self.assertEqual(candidate["proposed_box_2d"], candidate["box_2d"])
        self.assertEqual((candidate["roi_id"], candidate["outline_id"]), ("roof", "outline"))
        self.assertEqual(candidate["validity"], "current")
        self.assertIn("SVP", self.provider.calls[0][1])
        self.assertIn("Sump outlines", self.provider.calls[0][1])
        self.assertIn("anchor", self.provider.calls[0][2]["items"]["required"])
        with Image.open(BytesIO(self.provider.calls[0][0])) as crop_image:
            self.assertEqual(crop_image.size, (crop["inference_width"], crop["inference_height"]))
        self.assertEqual(data["run"]["settings"]["system_prompt_version"], "outlet-system-v1")
        self.assertIn("untrusted", OUTLET_SYSTEM_PROMPT)

    async def test_boundary_anchor_unchanged_opening_and_concave_notch_need_review(self):
        scope = self.request()["scopes"][0]
        scope["polygons"][0]["holes"] = [rectangle(550, 350, 650, 450)]
        # Compute normalized crop coordinates from the known original crop.
        from backend.app.outline_geometry import prepare_outline_crop
        crop = prepare_outline_crop(self.image, [200, 200, 800, 800]).crop
        def at(x, y):
            return inlet((x - crop["x"]) * 1000 / crop["width"], (y - crop["y"]) * 1000 / crop["height"])
        self.provider.result = ProviderResult(json.dumps([at(240, 300), at(600, 400), at(220, 300)]))
        response = await self.generate(scopes=[scope])
        self.assertEqual(response.status_code, 200, response.text)
        candidates = response.json()["annotations"]
        self.assertEqual(candidates[0]["validity"], "current")
        self.assertAlmostEqual(candidates[0]["anchor"]["x"], 240)
        self.assertEqual(candidates[1]["warnings"], ["outlet_in_opening"])
        self.assertEqual(candidates[2]["warnings"], ["outlet_outside_scope"])
        scope["polygons"][0] = {"outer": [{"x": 240, "y": 160}, {"x": 960, "y": 160},
            {"x": 960, "y": 640}, {"x": 700, "y": 640}, {"x": 700, "y": 300}, {"x": 240, "y": 300}], "holes": []}
        self.provider.result = ProviderResult(json.dumps([at(600, 400)]))
        response = await self.generate(request_id="notch", scopes=[scope])
        self.assertEqual(response.json()["annotations"][0]["warnings"], ["outlet_outside_scope"])

    async def test_scope_snapshot_and_actual_geometry_both_invalidate_cache(self):
        first = await self.generate()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual((await self.generate()).json(), first.json())
        cached = (await self.generate(request_id="cached")).json()
        self.assertTrue(cached["run"]["cached"])
        self.assertEqual(cached["annotations"], first.json()["annotations"])
        changed = await self.generate(request_id="opening-edit", scope_signature="scope-v2")
        self.assertFalse(changed.json()["run"]["cached"])
        scopes = self.request()["scopes"]
        scopes[0]["polygons"][0]["holes"] = [rectangle(550, 350, 650, 450)]
        self.assertEqual((await self.generate(request_id="geometry", scopes=scopes)).status_code, 200)
        self.assertEqual(len(self.provider.calls), 3)
        self.assertEqual((await self.generate(scope_signature="conflict")).status_code, 409)
        self.now = 6
        self.assertEqual((await self.generate(request_id="expired-cache")).status_code, 200)
        self.assertEqual(len(self.provider.calls), 4)

    async def test_touching_opening_boundary_stays_excluded_after_boolean_difference(self):
        from backend.app.outline_geometry import prepare_outline_crop
        scope = self.request()["scopes"][0]
        scope["polygons"][0] = {"outer": [{"x": 240, "y": 160}, {"x": 960, "y": 160},
            {"x": 960, "y": 640}, {"x": 700, "y": 640}, {"x": 700, "y": 300}, {"x": 240, "y": 300}], "holes": []}
        crop = prepare_outline_crop(self.image, [200, 200, 800, 800]).crop
        x, y = (700 - crop["x"]) * 1000 / crop["width"], (400 - crop["y"]) * 1000 / crop["height"]
        self.provider.result = ProviderResult(json.dumps([inlet(x, y)]))
        # As an actual outer concave corner, the edge is eligible.
        first = await self.generate(scopes=[scope])
        self.assertEqual(first.json()["annotations"][0]["validity"], "current")
        # The identical net polygon can instead have been made by an opening.
        # Preserve that semantic distinction without shifting the anchor.
        scope["excluded_openings"] = [rectangle(240, 300, 700, 640)]
        second = await self.generate(request_id="opening-notch", scopes=[scope])
        self.assertFalse(second.json()["run"]["cached"])
        candidate = second.json()["annotations"][0]
        self.assertEqual(candidate["warnings"], ["outlet_in_opening"])
        self.assertEqual(candidate["validity"], "needs_review")
        self.assertAlmostEqual(candidate["anchor"]["x"], 700)
        self.assertAlmostEqual(candidate["anchor"]["y"], 400)
        self.assertIn("excluded_openings", self.provider.calls[-1][1])

    async def test_ownership_contract_and_invalid_scope_fail_before_call(self):
        self.assertEqual((await self.generate(headers={"Authorization": "Bearer " + "b" * 64})).status_code, 404)
        self.assertEqual((await self.generate(source_image_hash="f" * 64)).status_code, 409)
        self.assertEqual((await self.generate(page_id="another-page")).status_code, 409)
        self.assertEqual((await self.generate(roi_revision=True)).status_code, 422)
        self.assertEqual((await self.generate(contract_version="outlet-0")).status_code, 422)
        self.assertEqual((await self.generate(scope_signature="x" * 257)).status_code, 422)
        scopes = self.request()["scopes"]
        scopes[0]["roi_id"] = "other"
        self.assertEqual((await self.generate(scopes=scopes)).status_code, 422)
        scopes = self.request()["scopes"]
        scopes[0]["polygons"][0]["outer"][0]["x"] = 1201
        self.assertEqual((await self.generate(scopes=scopes)).json()["error"]["code"], "invalid_scope_geometry")
        scopes[0]["polygons"][0]["outer"] = [{"x": 240, "y": 160}, {"x": 960, "y": 640},
                                                   {"x": 960, "y": 160}, {"x": 240, "y": 640}]
        self.assertEqual((await self.generate(scopes=scopes)).json()["error"]["code"], "invalid_scope_geometry")
        too_large = await self.client.post(PREFIX + "/pages/page/outlets", content=b"x" * (512 * 1024 + 1))
        self.assertEqual(too_large.status_code, 413)
        self.assertFalse(self.provider.calls)

    async def test_empty_and_partial_not_confused_and_duplicate_anchors_reconciled(self):
        self.provider.result = ProviderResult("[]")
        self.assertEqual((await self.generate()).json()["status"], "no_detections")
        self.provider.result = ProviderResult(json.dumps([inlet(), inlet(500.1, 500.1)]))
        result = (await self.generate(request_id="duplicates", scope_signature="v2")).json()
        self.assertEqual(len(result["annotations"]), 1)
        self.provider.result = ProviderResult("[]", "MAX_TOKENS")
        result = (await self.generate(request_id="partial", scope_signature="v3")).json()
        self.assertEqual(result["status"], "partial")
        self.assertIn("possible_truncation", result["warnings"])
        self.assertEqual(result["annotations"], [])

    async def test_multiple_scopes_and_budget_partial_share_call_ledger(self):
        scopes = self.request()["scopes"]
        second = deepcopy(scopes[0])
        second["outline_id"] = "second-outline"
        second["polygons"][0]["outer"] = rectangle(20, 30, 180, 160)
        result = (await self.generate(scopes=[*scopes, second])).json()
        self.assertEqual({item["outline_id"] for item in result["annotations"]}, {"outline", "second-outline"})
        self.assertEqual(result["run"]["provider_attempts"], 2)
        self.service.settings = Settings(max_calls_per_session=3, max_total_calls=3)
        partial = (await self.generate(request_id="limited", scope_signature="changed", scopes=[*scopes, second])).json()
        self.assertEqual(partial["status"], "partial")
        self.assertIn("outlet_call_budget_reached", partial["warnings"])
        self.assertEqual(len(partial["annotations"]), 1)
        self.assertEqual(self.service.total_calls, 3)
        self.assertEqual(self.service.active_calls, 0)
        limited = await self.generate(request_id="exhausted", scope_signature="changed-again")
        self.assertEqual(limited.json()["error"]["code"], "call_budget_exceeded")

    async def test_combined_annotation_limit_is_partial_even_on_final_crop(self):
        self.service.settings = Settings(max_annotations=3)
        scopes = self.request()["scopes"]
        second = deepcopy(scopes[0])
        second["outline_id"] = "second-outline"
        self.provider.result = ProviderResult(json.dumps([inlet(400, 400), inlet(600, 600)]))
        response = await self.generate(scopes=[*scopes, second])
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(len(result["annotations"]), 3)
        self.assertIn("outlet_annotation_limit_reached", result["warnings"])

    async def test_invalid_or_truncated_output_is_not_applied_or_cached(self):
        cases = [ProviderResult("private bad output"), ProviderResult("[", "MAX_TOKENS"),
                 ProviderResult(json.dumps([inlet(anchor={"x": 600, "y": 500})])),
                 ProviderResult(json.dumps([inlet(subtype="svp")])),
                 ProviderResult('[{"label":"one","label":"two"}]'),
                 ProviderResult(json.dumps([inlet(anchor={"x": True, "y": 500})]))]
        for index, result in enumerate(cases):
            self.provider.result = result
            response = await self.generate(request_id=f"invalid-{index}")
            self.assertEqual(response.status_code, 502, response.text)
            self.assertNotIn("private", response.text)
            self.assertIn(response.json()["error"]["code"], {"malformed_output", "truncated_output"})
        self.assertFalse(next(iter(self.service.sessions.values())).pages["page"].outlet_cache)

    async def test_concurrent_duplicate_delete_and_shared_concurrency(self):
        self.service.settings = Settings(max_concurrent_requests=1)
        self.provider.release.clear()
        first = asyncio.create_task(self.generate())
        await self.provider.started.wait()
        duplicate = asyncio.create_task(self.generate())
        crowded = await self.generate(request_id="crowded")
        self.assertEqual(crowded.json()["error"]["code"], "concurrency_limit_exceeded")
        self.provider.release.set()
        first_response, duplicate_response = await asyncio.gather(first, duplicate)
        self.assertEqual(first_response.json(), duplicate_response.json())
        self.assertEqual(len(self.provider.calls), 1)
        self.provider.release.clear()
        self.provider.started.clear()
        pending = asyncio.create_task(self.generate(request_id="delete", scope_signature="v2"))
        await self.provider.started.wait()
        await self.client.delete(PREFIX + "/pages/page")
        self.assertEqual((await pending).status_code, 404)
        self.assertTrue(self.provider.cancelled.is_set())
        self.assertEqual(self.service.active_calls, 0)

    async def test_overview_is_separate_and_timeout_disabled_expiry_remain_safe(self):
        calls = []
        async def with_context(image, prompt, schema, overview):
            calls.append((image, prompt, schema, overview))
            return self.provider.result
        self.provider.generate_outlets_with_context = with_context
        response = await self.generate()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotEqual(calls[0][0], calls[0][3])
        self.assertTrue(response.json()["run"]["settings"]["overview_supplied"])
        with Image.open(BytesIO(calls[0][3])) as overview:
            self.assertEqual(overview.size, (1024, 683))
        del self.provider.generate_outlets_with_context
        self.provider.ready = False
        self.assertEqual((await self.generate(request_id="disabled")).json()["error"]["code"], "provider_not_configured")
        self.provider.ready = True
        self.service.settings = Settings(timeout_seconds=.1)
        self.provider.release.clear()
        timeout = await self.generate(request_id="timeout")
        self.assertEqual(timeout.json()["error"]["code"], "provider_timeout")
        self.assertEqual(self.service.active_calls, 0)
        self.now = 11
        self.assertEqual((await self.generate(request_id="expired")).status_code, 404)


class OutletCropTests(unittest.TestCase):
    def test_tile_with_corners_in_separate_openings_keeps_roof_between_them(self):
        polygon = ScopePolygon.model_validate({"outer": rectangle(0, 0, 6000, 6000), "holes": [
            rectangle(1900, 1900, 2100, 2100), rectangle(3900, 1900, 4100, 2100),
            rectangle(1900, 3900, 2100, 4100), rectangle(3900, 3900, 4100, 4100),
        ]})
        self.assertTrue(_overlaps_polygon((2000, 2000, 4000, 4000), polygon))

    def test_large_scopes_have_bounded_overlapping_tiles(self):
        request = OutletInput.model_validate({"contract_version": "outlet-1", "page_id": "page", "request_id": "req",
            "source_image_hash": "a" * 64, "scope_signature": "s", "roi_revision": 1, "geometry_revision": 0,
            "accepted_rois": [{"id": "roof", "revision": 1, "box_2d": [0, 0, 1000, 1000]}],
            "scopes": [{"roi_id": "roof", "outline_id": "outline", "polygons": [
                {"outer": rectangle(0, 0, 6000, 6000), "holes": []}]}]})
        crops, limited = plan_crops(request, 6000, 6000)
        self.assertEqual(len(crops), MAX_CROPS)
        self.assertTrue(limited)
        self.assertLess(crops[1][1][1], crops[0][1][3])
        for _scope, (top, left, bottom, right) in crops:
            self.assertLessEqual((right - left) * 6, 2048.0001)
            self.assertLessEqual((bottom - top) * 6, 2048.0001)

    def test_parser_rejects_nan_extra_fields_and_unbounded_lists(self):
        for value in ['[{"anchor":{"x":NaN,"y":0}}]', json.dumps([inlet(), inlet()]),
                      json.dumps([inlet(diameter=150)])]:
            with self.assertRaises(RoiError):
                parse_outlets(value, 10000, 1)


class OutletProviderWireTests(unittest.IsolatedAsyncioTestCase):
    async def test_outlet_specific_system_and_first_crop_coordinate_frame(self):
        captured = []
        def respond(request):
            captured.append(json.loads(request.content))
            event = {"candidates": [{"content": {"parts": [{"text": "[]"}]}, "finishReason": "STOP"}]}
            return httpx.Response(200, text="data: " + json.dumps(event) + "\n\n",
                                  headers={"content-type": "text/event-stream"})
        client = genai.Client(vertexai=False, api_key="synthetic-not-a-real-key", http_options=types.HttpOptions(
            retry_options=types.HttpRetryOptions(attempts=1),
            async_client_args={"transport": httpx.MockTransport(respond)},
        ))
        provider = GeminiProvider(Settings(allow_live=True, api_key="synthetic-not-a-real-key", structured_output=True), client)
        try:
            result = await provider.generate_outlets_with_context(b"crop", "Find rainwater inlets", model_schema(25), b"overview")
            self.assertEqual(result.text, "[]")
            parts = captured[0]["contents"][0]["parts"]
            images = [part["inlineData"] for part in parts if "inlineData" in part]
            self.assertEqual([base64.b64decode(item["data"]) for item in images], [b"crop", b"overview"])
            self.assertEqual(captured[0]["systemInstruction"]["parts"][0]["text"], OUTLET_SYSTEM_PROMPT)
            self.assertEqual(captured[0]["generationConfig"]["responseJsonSchema"], model_schema(25))
            self.assertEqual(captured[0]["generationConfig"]["maxOutputTokens"], 32768)
        finally:
            await provider.close()
