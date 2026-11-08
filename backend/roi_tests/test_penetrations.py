import json
import unittest
from hashlib import sha256

import httpx

from backend.app.config import Settings
from backend.app.errors import RoiError
from backend.app.gemini import ProviderResult
from backend.app.main import PREFIX, create_app
from backend.app.models import DetectionInput, DetectionVector
from backend.app.parsing import parse_proposals
from backend.app.penetration_geometry import plan_crops, refine_ring
from test_api import FakeProvider, TOKEN
from test_images import image_bytes


def ring(values):
    return [{"x": x, "y": y} for x, y in values]


class PenetrationGeometryTests(unittest.TestCase):
    def test_concave_ring_snaps_to_closed_vector_without_becoming_hull_or_rectangle(self):
        target = [(20, 20), (60, 30), (50, 60), (40, 50), (30, 55), (15, 40)]
        proposal = [(x + .3, y + .2) for x, y in target]
        vectors = [DetectionVector(start={"x": a[0], "y": a[1]}, end={"x": b[0], "y": b[1]})
                   for a, b in zip(target, target[1:] + target[:1])]
        fitted, source, warnings = refine_ring(proposal, vectors)
        self.assertEqual(source, "vector")
        self.assertEqual(set(fitted), set(target))
        self.assertEqual(warnings, [])
        unsupported, source, warnings = refine_ring(proposal, [])
        self.assertEqual(unsupported, proposal)
        self.assertEqual(source, "model")
        self.assertIn("penetration_boundary_unverified", warnings)

    def test_model_polygon_rejects_self_intersection_and_accepts_legacy_box(self):
        record = {"label": "Riser", "subtype": "riser", "roi_id": "roof", "box_2d": [10, 10, 90, 90]}
        self.assertIsNone(parse_proposals(json.dumps([record]), "penetration", {"roof"}, 10000, 25)[0].footprint)
        record["footprint"] = ring([(10, 10), (90, 90), (10, 90), (90, 10)])
        with self.assertRaises(RoiError):
            parse_proposals(json.dumps([record]), "penetration", {"roof"}, 10000, 25)

    def test_large_source_is_tiled_with_overlap_and_bounded_coverage(self):
        request = DetectionInput(page_id="page", request_id="request", task="penetration",
            source_image_hash="a" * 64, roi_revision=1, geometry_revision=1,
            accepted_rois=[{"id": "roof", "revision": 1, "box_2d": [0, 0, 1000, 1000]}],
            scopes=[{"roi_id": "roof", "outline_id": "outline", "outer": ring([(0, 0), (10000, 0), (10000, 10000), (0, 10000)])}])
        crops, limited = plan_crops(request, 10000, 10000)
        self.assertEqual(len(crops), 8)
        self.assertTrue(limited)
        self.assertLess(crops[1][1][1], crops[0][1][3])


class PenetrationApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.provider = FakeProvider()
        self.app = create_app(Settings(), self.provider)
        self.service = self.app.state.roi_service
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 1234)),
            base_url="http://127.0.0.1", headers=TOKEN)
        self.image = image_bytes((100, 200))
        self.context = dict(document_id="document", file_name="synthetic.pdf", page_id="page", page_index=0,
            source_image_hash=sha256(self.image).hexdigest(), source_width=100, source_height=200,
            render_scale=2, render_rotation=0, render_version="test", pdf_view_box=[0, 0, 50, 100])
        uploaded = await self.client.post(PREFIX + "/pages", data={"context": json.dumps(self.context)},
            files={"image": ("plan.png", self.image, "image/png")})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        self.scope = {"roi_id": "roof", "outline_id": "outline", "outer": ring([(0, 0), (100, 0), (100, 200), (0, 200)])}
        self.record = {"label": "Riser", "subtype": "riser", "roi_id": "roof", "box_2d": [200, 200, 500, 600],
            "footprint": ring([(200, 200), (600, 250), (550, 500), (400, 400), (250, 450)])}
        self.provider.result = ProviderResult(json.dumps([self.record]))

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.service.close()

    async def detect(self, **changes):
        request = dict(page_id="page", request_id="request", task="penetration", roi_revision=1, geometry_revision=1,
            source_image_hash=self.context["source_image_hash"],
            accepted_rois=[{"id": "roof", "revision": 1, "box_2d": [0, 0, 1000, 1000]}], scopes=[self.scope])
        request.update(changes)
        return await self.client.post(PREFIX + "/pages/page/detections", json=request)

    async def test_polygon_maps_to_source_pixels_preserves_proposal_and_cache(self):
        response = await self.detect()
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "complete")
        annotation = data["annotations"][0]
        expected = ring([(20, 40), (60, 50), (55, 100), (40, 80), (25, 90)])
        for field in ("footprint", "proposed_footprint"):
            for actual, target in zip(annotation[field], expected):
                self.assertAlmostEqual(actual["x"], target["x"])
                self.assertAlmostEqual(actual["y"], target["y"])
        self.assertEqual(annotation["outline_id"], "outline")
        self.assertEqual(annotation["footprint_source"], "model")
        self.assertIn("penetration_coverage_requires_review", data["warnings"])
        replay = await self.detect(request_id="cached")
        self.assertEqual(replay.json()["annotations"], data["annotations"])
        self.assertTrue(replay.json()["run"]["cached"])
        self.assertEqual(replay.json()["run"]["settings"]["crops"], data["run"]["settings"]["crops"])
        self.assertEqual(len(self.provider.calls), 1)
        changed = await self.detect(request_id="new-scope", scopes=[{**self.scope, "holes": [ring([(70, 120), (80, 120), (80, 130), (70, 130)])]}])
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(len(self.provider.calls), 2)

    async def test_duplicate_scopes_merge_objects_and_call_budget_returns_partial(self):
        duplicate_scope = {**self.scope, "outline_id": "second"}
        response = await self.detect(scopes=[self.scope, duplicate_scope])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["annotations"]), 1)
        self.assertEqual(response.json()["run"]["provider_attempts"], 2)
        self.service.settings = Settings(max_calls_per_session=3)
        limited = await self.detect(request_id="budget", geometry_revision=2, scopes=[self.scope, duplicate_scope])
        self.assertEqual(limited.status_code, 200, limited.text)
        self.assertEqual(limited.json()["status"], "partial")
        self.assertIn("penetration_call_budget_reached", limited.json()["warnings"])

    async def test_unknown_is_reviewable_and_complete_scan_allows_one_missed_object_pass(self):
        self.provider.result = ProviderResult(json.dumps([{**self.record, "subtype": "unknown"}]))
        response = await self.detect()
        self.assertIn("penetration_type_requires_review", response.json()["annotations"][0]["warnings"])
        follow = await self.detect(request_id="follow", follow_up_of="request")
        self.assertEqual(follow.status_code, 200, follow.text)
        self.assertIn("Previously proposed objects", self.provider.calls[1][1])
        third = await self.detect(request_id="third", follow_up_of="request")
        self.assertEqual(third.status_code, 429)

    async def test_invalid_scope_rejected_before_any_provider_call(self):
        response = await self.detect(scopes=[{**self.scope, "outer": ring([(0, 0), (101, 0), (101, 200), (0, 200)])}])
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.provider.calls, [])

    async def test_unoutlined_parent_is_reported_as_incomplete_coverage(self):
        response = await self.detect(accepted_rois=[
            {"id": "roof", "revision": 1, "box_2d": [0, 0, 1000, 1000]},
            {"id": "unoutlined", "revision": 1, "box_2d": [0, 0, 1000, 1000]},
        ])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "partial")
        self.assertIn("penetration_scope_incomplete", response.json()["warnings"])
        self.assertFalse(response.json()["run"]["settings"]["coverage_complete"])
