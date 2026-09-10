import asyncio
from hashlib import sha256
import json
import sys
import unittest
from unittest.mock import patch

import httpx

from backend.roi_app.config import Settings
from backend.roi_app.errors import OutputDiagnostic, RoiError
from backend.roi_app.gemini import ProviderResult
from backend.roi_app.main import PREFIX, create_app
from test_images import image_bytes


ROOF = '[{"label":"Flat roof","box_2d":[10.5,20,300,400]}]'
CHILD = '[{"label":"Vent","box_2d":[20,30,40,50],"roi_id":"roof","subtype":"vent"}]'
TOKEN = {"Authorization": "Bearer " + "a" * 64}


class FakeProvider:
    ready = True

    def __init__(self):
        self.result = ProviderResult(ROOF)
        self.errors = []
        self.calls = []
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()
        self.cancelled = asyncio.Event()
        self.closed = False

    async def generate(self, image, prompt, schema):
        self.calls.append((image, prompt, schema))
        self.started.set()
        try:
            await self.release.wait()
        except asyncio.CancelledError:
            self.cancelled.set()
            raise
        if self.errors:
            raise self.errors.pop(0)
        return self.result

    async def close(self):
        self.closed = True


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.now = 0.0
        self.provider = FakeProvider()
        self.settings = Settings(page_ttl_seconds=10, cache_ttl_seconds=5, session_ttl_seconds=20)
        self.app = create_app(self.settings, self.provider, lambda: self.now)
        self.service = self.app.state.roi_service
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 1234)),
                                       base_url="http://127.0.0.1", headers=TOKEN)
        self.image = image_bytes((100, 200))
        self.context = dict(document_id="document", file_name="private.pdf", page_id="page", page_index=0,
                            source_image_hash=sha256(self.image).hexdigest(), source_width=100, source_height=200,
                            render_scale=2, render_rotation=90, render_version="pdfjs-test", pdf_view_box=[0, 0, 50, 100])

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.service.close()

    async def upload(self, context=None, image=None, headers=None):
        return await self.client.post(PREFIX + "/pages", data={"context": json.dumps(context or self.context)},
                                      files={"image": ("../../private.png", image or self.image, "image/png")}, headers=headers)

    def request(self, **changes):
        return dict(dict(page_id="page", request_id="request", source_image_hash=self.context["source_image_hash"],
                         task="roof_roi", roi_revision=None, geometry_revision=0), **changes)

    async def detect(self, **changes):
        return await self.client.post(PREFIX + "/pages/page/detections", json=self.request(**changes))

    async def test_health_no_provider_call_and_no_legacy_imports(self):
        response = await self.client.get(PREFIX + "/health")
        self.assertEqual(response.json()["status"], "ready")
        self.assertEqual(self.provider.calls, [])
        self.assertFalse(any(name == "backend.app" or name.startswith("backend.app.") for name in sys.modules))
        self.assertNotIn("GOOGLE_API_KEY", response.text)

    async def test_upload_immutable_identity_ownership_and_delete(self):
        response = await self.upload()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["page"], self.context)
        self.assertTrue(response.json()["upload_id"].startswith("upload_"))
        again = await self.upload()
        self.assertEqual(response.json()["upload_id"], again.json()["upload_id"])
        changed = await self.upload(context={**self.context, "render_rotation": 0})
        self.assertEqual(changed.status_code, 409)
        other = await self.client.post(PREFIX + "/pages/page/detections", json=self.request(),
                                       headers={"Authorization": "Bearer " + "b" * 64})
        self.assertEqual(other.status_code, 404)
        other_delete = await self.client.delete(PREFIX + "/pages/page", headers={"Authorization": "Bearer " + "b" * 64})
        self.assertEqual(other_delete.status_code, 404)
        self.assertEqual((await self.client.delete(PREFIX + "/pages/page")).status_code, 204)
        self.assertEqual((await self.detect()).status_code, 404)

    async def test_server_checks_hash_dimensions_and_bad_upload(self):
        for field, value in (("source_width", 99), ("source_image_hash", "0" * 64)):
            response = await self.upload(context={**self.context, field: value})
            self.assertEqual(response.status_code, 409)
        self.assertEqual((await self.upload(image=b"invalid")).status_code, 422)
        self.assertEqual((await self.upload(headers={"Authorization": ""})).status_code, 401)
        response = await self.upload(context={**self.context, "source_height": "private secret"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("private", response.text)

    async def test_request_identity_cache_and_revision_keys(self):
        await self.upload()
        first = (await self.detect()).json()
        self.assertEqual(first["annotations"][0]["review_status"], "suggested")
        self.assertEqual(first["annotations"][0]["proposed_box_2d"], [10.5, 20, 300, 400])
        self.assertIsNone(first["roi_revision"])
        self.assertIsNone(first["run"]["roi_revision"])
        self.assertIsNone(first["annotations"][0]["roi_id"])
        self.assertEqual((await self.detect()).json(), first)
        cached = (await self.detect(request_id="second")).json()
        self.assertTrue(cached["run"]["cached"])
        self.assertEqual(cached["annotations"], first["annotations"])
        self.assertEqual(cached["run"]["request_id"], "second")
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual((await self.detect(geometry_revision=1)).status_code, 409)
        await self.detect(request_id="third", geometry_revision=1)
        self.assertEqual(len(self.provider.calls), 2)
        self.now = 6
        await self.detect(request_id="expired-cache")
        self.assertEqual(len(self.provider.calls), 3)

    async def test_children_require_parent_and_cache_tracks_all_revisions(self):
        await self.upload()
        self.provider.result = ProviderResult(CHILD)
        parent = {"id": "roof", "revision": 1, "box_2d": [0, 0, 500, 500]}
        self.assertEqual((await self.detect(task="penetration", roi_revision=1)).status_code, 422)
        for index, changes in enumerate(({}, {"roi_revision": 2}, {"geometry_revision": 2},
                                         {"accepted_rois": [{**parent, "revision": 2}]},
                                         {"accepted_rois": [{**parent, "box_2d": [0, 0, 501, 500]}]})):
            body = {"task": "penetration", "roi_revision": 1, "accepted_rois": [parent], **changes,
                    "request_id": f"child_{index}"}
            response = await self.detect(**body)
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(self.provider.calls), 5)
        self.assertIn('"id":"roof"', self.provider.calls[0][1])
        response = await self.detect(task="penetration", roi_revision=1, request_id="unknown-parent",
                                     accepted_rois=[{**parent, "id": "other"}])
        self.assertEqual(response.json()["error"]["code"], "malformed_output")

    async def test_two_scope_replay_preserves_boxes_and_prompt_provenance(self):
        await self.upload()
        boxes = [[288, 202, 461, 276], [496, 202, 668, 276]]
        self.provider.result = ProviderResult(json.dumps([
            {"label": "proposed flat roof / tapered insulation scope area", "box_2d": box}
            for box in boxes
        ]))
        response = await self.detect()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["prompt_version"], "roof-roi-v2")
        self.assertEqual(result["run"]["prompt_version"], "roof-roi-v2")
        self.assertEqual([annotation["box_2d"] for annotation in result["annotations"]], boxes)
        self.assertEqual([annotation["proposed_box_2d"] for annotation in result["annotations"]], boxes)
        self.assertEqual(len({annotation["id"] for annotation in result["annotations"]}), 2)
        for annotation in result["annotations"]:
            self.assertEqual(annotation["review_status"], "suggested")
            self.assertEqual(annotation["page_id"], "page")
        self.assertEqual(len(self.provider.calls), 1)
        self.assertIn("Do not return a box for the whole drawing sheet or the whole roof plan.", self.provider.calls[0][1])
        cached = (await self.detect(request_id="replay-cached")).json()
        self.assertTrue(cached["run"]["cached"])
        self.assertEqual(cached["annotations"], result["annotations"])
        self.assertEqual(len(self.provider.calls), 1)

    async def test_empty_partial_truncation_and_bounded_follow_up(self):
        await self.upload()
        self.provider.result = ProviderResult("[]")
        self.assertEqual((await self.detect()).json()["status"], "no_detections")
        self.provider.result = ProviderResult(ROOF, "MAX_TOKENS")
        partial = await self.detect(request_id="partial", geometry_revision=1)
        self.assertEqual(partial.json()["status"], "partial")
        follow = await self.detect(request_id="follow", geometry_revision=1, follow_up_of="partial")
        self.assertEqual(follow.json()["status"], "partial")
        self.assertIn("Previously proposed", self.provider.calls[-1][1])
        capped = await self.detect(request_id="follow-again", geometry_revision=1, follow_up_of="partial")
        self.assertEqual(capped.status_code, 429)
        self.provider.result = ProviderResult("[", "MAX_TOKENS")
        truncated = await self.detect(request_id="truncated", geometry_revision=2)
        self.assertEqual(truncated.json()["error"]["code"], "truncated_output")

    async def test_transient_retry_dedup_and_terminal_errors(self):
        await self.upload()
        self.provider.errors = [RoiError("provider_unavailable", 502, True)]
        response = await self.detect()
        self.assertEqual(response.json()["run"]["provider_attempts"], 2)
        await self.detect()
        self.assertEqual(len(self.provider.calls), 2)
        for index, code in enumerate(("authentication_failed", "model_unavailable", "provider_refusal", "malformed_output")):
            self.provider.errors = [RoiError(code, 502)]
            before = len(self.provider.calls)
            result = await self.detect(request_id=code, geometry_revision=index + 1)
            self.assertEqual(result.json()["error"]["code"], code)
            await self.detect(request_id=code, geometry_revision=index + 1)
            self.assertEqual(len(self.provider.calls), before + 1)

    async def test_output_diagnostics_are_safe_terminal_and_not_cached_as_success(self):
        await self.upload()
        cases = (
            (ProviderResult("private output"), None, "malformed_output", "json_syntax", "STOP"),
            (ProviderResult("private output", "MAX_TOKENS"), None, "truncated_output", "json_syntax", "MAX_TOKENS"),
            (ProviderResult(""), None, "malformed_output", "empty_text", "STOP"),
            (ProviderResult(ROOF), RoiError("malformed_output", 502, diagnostic=OutputDiagnostic.STREAM_MISSING_FINISH),
             "malformed_output", "stream_missing_finish", "unavailable"),
        )
        for index, (output, error, code, category, finish) in enumerate(cases):
            self.provider.result = output
            self.provider.errors = [error] if error else []
            request_id = f"diagnostic-{index}"
            before = len(self.provider.calls)
            with self.assertLogs("roi_app.detections", level="WARNING") as captured:
                response = await self.detect(request_id=request_id)
            self.assertEqual(response.json(), {"error": {"code": code, "retryable": False}})
            self.assertEqual(len(captured.output), 1)
            message = captured.output[0]
            for expected in (f"request_id={request_id}", f"category={category}", f"finish={finish}"):
                self.assertIn(expected, message)
            for private in ("private", "Flat roof", self.context["source_image_hash"], TOKEN["Authorization"]):
                self.assertNotIn(private, message)
            self.assertEqual(len(self.provider.calls), before + 1)
            self.assertFalse(self.service.sessions[next(iter(self.service.sessions))].pages["page"].cache)
            with self.assertNoLogs("roi_app.detections", level="WARNING"):
                duplicate = await self.detect(request_id=request_id)
            self.assertEqual(duplicate.json(), response.json())
            self.assertEqual(len(self.provider.calls), before + 1)

    async def test_crlf_fenced_output_returns_valid_suggested_annotations(self):
        await self.upload()
        self.provider.result = ProviderResult(f"```JSON\r\n{ROOF}\r\n```")
        with self.assertNoLogs("roi_app.detections", level="WARNING"):
            response = await self.detect()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "complete")
        annotation = response.json()["annotations"][0]
        self.assertEqual(annotation["box_2d"], [10.5, 20, 300, 400])
        self.assertEqual(annotation["proposed_box_2d"], annotation["box_2d"])
        self.assertEqual(annotation["review_status"], "suggested")
        self.assertEqual(annotation["page_id"], "page")
        self.assertEqual(len(self.provider.calls), 1)

    async def test_concurrent_duplicate_and_delete_during_detection(self):
        await self.upload()
        self.provider.release.clear()
        first = asyncio.create_task(self.detect())
        await self.provider.started.wait()
        duplicate = asyncio.create_task(self.detect())
        self.provider.release.set()
        responses = await asyncio.gather(first, duplicate)
        self.assertEqual(responses[0].json(), responses[1].json())
        self.assertEqual(len(self.provider.calls), 1)
        self.provider.release.clear()
        self.provider.started.clear()
        pending = asyncio.create_task(self.detect(request_id="delete", geometry_revision=1))
        await self.provider.started.wait()
        await self.client.delete(PREFIX + "/pages/page")
        self.assertEqual((await pending).status_code, 404)
        self.assertTrue(self.provider.cancelled.is_set())
        self.assertEqual(self.service.active_calls, 0)

    async def test_expiry_and_cors(self):
        await self.upload()
        self.now = 11
        self.service.cleanup()
        self.assertEqual((await self.detect()).status_code, 404)
        denied = await self.upload(headers={"Origin": "https://untrusted.example"})
        self.assertEqual(denied.status_code, 403)
        preflight = await self.client.options(PREFIX + "/pages", headers={
            "Origin": "http://127.0.0.1:8080", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type"})
        self.assertEqual(preflight.status_code, 200)
        self.assertEqual(preflight.headers["access-control-allow-origin"], "http://127.0.0.1:8080")

    async def test_timeout_releases_capacity_without_retry(self):
        await self.upload()
        self.service.settings = Settings(timeout_seconds=0.01)
        self.provider.release.clear()
        response = await self.detect()
        self.assertEqual(response.status_code, 504)
        self.assertEqual(response.json()["error"]["code"], "provider_timeout")
        self.assertTrue(self.provider.cancelled.is_set())
        self.assertEqual(self.service.active_calls, 0)
        self.assertEqual(len(self.provider.calls), 1)

    async def test_concurrency_and_cost_budgets(self):
        await self.upload()
        self.service.settings = Settings(max_concurrent_requests=1, max_calls_per_session=1, max_total_calls=1)
        self.provider.release.clear()
        first = asyncio.create_task(self.detect())
        await self.provider.started.wait()
        crowded = await self.detect(request_id="crowded", geometry_revision=1)
        self.assertEqual(crowded.json()["error"]["code"], "concurrency_limit_exceeded")
        self.provider.release.set()
        await first
        limited = await self.detect(request_id="budget", geometry_revision=1)
        self.assertEqual(limited.json()["error"]["code"], "call_budget_exceeded")
        await self.client.delete(PREFIX + "/pages/page")
        await self.upload()
        self.assertEqual((await self.detect(request_id="after-delete")).status_code, 429)
        self.assertEqual(len(self.provider.calls), 1)

    async def test_retry_budget_and_request_ledger_bound(self):
        await self.upload()
        self.service.settings = Settings(max_calls_per_session=1, max_requests_per_session=1)
        self.provider.errors = [RoiError("provider_unavailable", 502, True)]
        self.assertEqual((await self.detect()).json()["error"]["code"], "call_budget_exceeded")
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual((await self.detect(request_id="new")).json()["error"]["code"], "request_limit_exceeded")

    async def test_annotation_cap_is_partial(self):
        await self.upload()
        self.provider.result = ProviderResult(json.dumps(json.loads(ROOF) * 25))
        response = await self.detect()
        self.assertEqual(response.json()["status"], "partial")
        self.assertIn("possible_truncation", response.json()["warnings"])
        self.provider.result = ProviderResult(json.dumps(json.loads(ROOF) * 26))
        oversized = await self.detect(request_id="oversized", geometry_revision=1)
        self.assertEqual(oversized.json()["error"]["code"], "annotation_limit_exceeded")

    async def test_body_limits_without_content_length_and_localhost_guard(self):
        async def chunks():
            yield b"x" * 40000
            yield b"x" * 40000

        response = await self.client.post(PREFIX + "/pages/page/detections", content=chunks())
        self.assertEqual(response.status_code, 413)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("192.0.2.1", 1234)),
                                     base_url="http://127.0.0.1") as remote:
            self.assertEqual((await remote.get(PREFIX + "/health")).status_code, 403)
        self.assertEqual(self.provider.calls, [])

    async def test_storage_page_and_session_limits(self):
        self.service.settings = Settings(max_storage_bytes=1)
        self.assertEqual((await self.upload()).json()["error"]["code"], "storage_limit_exceeded")
        self.service.settings = Settings(max_pages_per_session=1, max_sessions=1)
        await self.upload()
        self.assertEqual((await self.upload(context={**self.context, "page_id": "second"})).status_code, 429)
        self.assertEqual((await self.upload(headers={"Authorization": "Bearer " + "b" * 64})).status_code, 429)

    async def test_disabled_health_and_detection(self):
        await self.upload()
        self.provider.ready = False
        self.assertEqual((await self.client.get(PREFIX + "/health")).json()["status"], "not_configured")
        self.assertEqual((await self.detect()).json()["error"]["code"], "provider_not_configured")
        self.assertEqual(self.provider.calls, [])

    async def test_cache_is_not_shared_across_owners(self):
        await self.upload()
        await self.detect()
        other = {"Authorization": "Bearer " + "b" * 64}
        await self.upload(headers=other)
        response = await self.client.post(PREFIX + "/pages/page/detections", json=self.request(), headers=other)
        self.assertFalse(response.json()["run"]["cached"])
        self.assertEqual(len(self.provider.calls), 2)

    async def test_boundary_outlet_is_not_rejected_by_interior_containment(self):
        await self.upload()
        self.provider.result = ProviderResult('[{"label":"Outlet","box_2d":[490,490,510,510],'
                                              '"roi_id":"roof","subtype":"scupper"}]')
        response = await self.detect(task="rainwater_outlet", roi_revision=1,
                                     accepted_rois=[{"id": "roof", "revision": 1, "box_2d": [100, 100, 500, 500]}])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["annotations"][0]["subtype"], "scupper")
        self.assertIn("category_policy_pending_domain_review", response.json()["warnings"])

    async def test_image_preparations_are_bounded(self):
        started, release = asyncio.Event(), asyncio.Event()

        async def delayed(function, *args):
            started.set()
            await release.wait()
            return function(*args)

        with patch("backend.roi_app.main.asyncio.to_thread", delayed):
            first = asyncio.create_task(self.upload())
            await started.wait()
            second = await self.upload(context={**self.context, "page_id": "second"})
            self.assertEqual(second.json()["error"]["code"], "upload_concurrency_limit_exceeded")
            release.set()
            self.assertEqual((await first).status_code, 200)

    async def test_lifespan_closes_provider_and_discards_storage(self):
        async with self.app.router.lifespan_context(self.app):
            await self.upload()
            self.assertTrue(self.service.sessions)
        self.assertEqual(self.service.sessions, {})
        self.assertTrue(self.provider.closed)