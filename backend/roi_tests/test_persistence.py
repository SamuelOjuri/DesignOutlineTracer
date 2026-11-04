"""Restart boundaries, ownership and paid-call accounting on a persistent disk."""
import asyncio
from contextlib import closing
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import unittest

from backend.app.config import Settings
from backend.app.errors import RoiError
from backend.app.gemini import ProviderResult
from backend.app.images import prepare_image
from backend.app.models import DetectionInput, PageContext
from backend.app.outline_models import OutlineInput
from backend.app.outline_service import OutlineService
from backend.app.outlet_models import OutletInput
from backend.app.outlet_service import OutletService
from backend.app.service import RoiService
from test_api import FakeProvider
from test_images import image_bytes
from test_outline_api import POLYGON
from test_outlet_api import inlet, rectangle


OWNER = sha256(b"anonymous-browser-capability").hexdigest()
OTHER = sha256(b"another-browser-capability").hexdigest()


class PersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.path = str(Path(self.directory.name) / "roi.sqlite3")
        self.now, self.wall = 20.0, 1_000_000.0
        self.settings = Settings(state_path=self.path, page_ttl_seconds=100, cache_ttl_seconds=5,
                                 session_ttl_seconds=200, call_budget_window_seconds=10)
        self.services = []
        self.service, self.provider = self.open_service()
        self.source = image_bytes((1200, 800))
        self.context = PageContext(document_id="document", file_name="private.pdf", page_id="page", page_index=0,
                                   source_image_hash=sha256(self.source).hexdigest(), source_width=1200,
                                   source_height=800, render_scale=2.0, render_rotation=0,
                                   render_version="pdfjs-test", pdf_view_box=(0.0, 0.0, 600.0, 400.0))
        self.receipt = self.service.upload(OWNER, self.context, prepare_image(self.source, self.settings))

    def open_service(self, provider=None):
        provider = provider or FakeProvider()
        service = RoiService(self.settings, provider, lambda: self.now, wall_clock=lambda: self.wall)
        self.services.append(service)
        return service, provider

    async def restart(self, seconds=2):
        await self.service.close()
        self.now = 0.0  # A different monotonic epoch, as after a machine restart.
        self.wall += seconds
        self.service, self.provider = self.open_service()

    async def asyncTearDown(self):
        for service in self.services:
            await service.close()
        self.directory.cleanup()

    def request(self, **changes):
        return DetectionInput.model_validate({"page_id": "page", "request_id": "detect",
            "source_image_hash": self.context.source_image_hash, "task": "roof_roi", "roi_revision": None,
            "geometry_revision": 0, **changes})

    def assert_error(self, code):
        return self.assertRaisesRegex(RoiError, f"^{code}$")

    async def test_restart_restores_page_owner_completed_request_and_cache(self):
        first = await self.service.detect(OWNER, self.request())
        await self.restart()
        session, page = self.service.get_page(OWNER, "page")
        self.assertEqual(page.image.original, self.source)
        self.assertEqual(page.upload_id, self.receipt["upload_id"])
        self.assertAlmostEqual(self.service.receipt(page)["expires_in_seconds"], 98)
        self.assertEqual((session.calls, self.service.total_calls), (1, 1))
        with self.assert_error("page_not_found"):
            self.service.get_page(OTHER, "page")
        self.assertEqual(await self.service.detect(OWNER, self.request()), first)
        cached = await self.service.detect(OWNER, self.request(request_id="new-id"))
        self.assertTrue(cached.run.cached)
        self.assertEqual(cached.annotations, first.annotations)
        self.assertEqual(self.provider.calls, [])
        with self.assert_error("request_identity_conflict"):
            await self.service.detect(OWNER, self.request(geometry_revision=1))

    async def test_restart_expiry_and_delete_remove_image_bytes_from_disk(self):
        await self.restart(seconds=101)
        with self.assert_error("page_not_found"):
            self.service.get_page(OWNER, "page")
        with closing(sqlite3.connect(self.path)) as database:
            self.assertEqual(database.execute("SELECT count(*) FROM images").fetchone()[0], 0)
        self.service.upload(OWNER, self.context, prepare_image(self.source, self.settings))
        self.service.delete(OWNER, "page")
        await self.restart()
        with self.assert_error("page_not_found"):
            self.service.get_page(OWNER, "page")
        with closing(sqlite3.connect(self.path)) as database:
            self.assertEqual(database.execute("SELECT count(*) FROM images").fetchone()[0], 0)

    async def test_paid_call_reservation_commits_before_provider_and_window_survives_restart(self):
        self.service.settings = self.settings = self.settings.model_copy(update={"max_total_calls": 1})
        provider_generate = self.provider.generate

        async def checked_generate(*args):
            with closing(sqlite3.connect(self.path)) as database:
                state = json.loads(database.execute("SELECT payload FROM state").fetchone()[0])
            self.assertEqual(state["total_calls"], 1)
            self.assertEqual(state["sessions"][OWNER]["calls"], 1)
            self.assertTrue(state["sessions"][OWNER]["operations"]["detect"]["interrupted"])
            return await provider_generate(*args)

        self.provider.generate = checked_generate
        await self.service.detect(OWNER, self.request())
        await self.restart()
        with self.assert_error("call_budget_exceeded"):
            await self.service.detect(OWNER, self.request(request_id="new", geometry_revision=1))
        self.assertEqual(self.provider.calls, [])
        # The persisted global window resets, while the anonymous session keeps its calls.
        self.now += 9
        self.wall += 9
        await self.service.detect(OWNER, self.request(request_id="after-window", geometry_revision=1))
        self.assertEqual((self.service.total_calls, self.service.sessions[OWNER].calls), (1, 2))

    async def test_interrupted_request_is_not_issued_twice_after_restart(self):
        self.provider.release.clear()
        pending = asyncio.create_task(self.service.detect(OWNER, self.request()))
        await self.provider.started.wait()
        await self.restart()
        await asyncio.gather(pending, return_exceptions=True)
        with self.assert_error("request_interrupted"):
            await self.service.detect(OWNER, self.request())
        self.assertEqual(self.provider.calls, [])
        self.assertEqual((self.service.total_calls, self.service.sessions[OWNER].calls), (1, 1))

    async def test_global_budget_uses_a_rolling_window_not_an_all_at_once_reset(self):
        self.service.settings = self.settings = self.settings.model_copy(update={"max_total_calls": 2})
        await self.service.detect(OWNER, self.request())
        self.now += 4
        self.wall += 4
        await self.service.detect(OWNER, self.request(request_id="second", geometry_revision=1))
        await self.restart(seconds=2)
        self.now += 5
        self.wall += 5
        # The first call is 11 seconds old; the second is only 7 seconds old.
        await self.service.detect(OWNER, self.request(request_id="third", geometry_revision=2))
        self.assertEqual(self.service.total_calls, 2)
        with self.assert_error("call_budget_exceeded"):
            await self.service.detect(OWNER, self.request(request_id="fourth", geometry_revision=3))

    async def test_failed_request_replays_without_a_second_paid_call(self):
        self.provider.errors = [RoiError("provider_refusal", 502)]
        with self.assert_error("provider_refusal"):
            await self.service.detect(OWNER, self.request())
        await self.restart()
        with self.assert_error("provider_refusal"):
            await self.service.detect(OWNER, self.request())
        self.assertEqual(self.provider.calls, [])

    async def test_single_writer_is_required(self):
        with self.assertRaisesRegex(RuntimeError, "exactly one"):
            RoiService(self.settings, FakeProvider())

    async def test_outline_and_outlet_results_and_caches_survive_restart(self):
        outline = OutlineInput.model_validate({"schema_version": "outline-1", "page_id": "page", "request_id": "outline",
            "source_image_hash": self.context.source_image_hash, "roi_revision": 1, "geometry_revision": 0,
            "roi": {"id": "roof", "revision": 1, "box_2d": [200, 200, 800, 800]},
            "boundary_policy": "inner_parapet", "boundary_notes": "", "vector_segments": []})
        outlet = OutletInput.model_validate({"contract_version": "outlet-1", "page_id": "page", "request_id": "outlet",
            "source_image_hash": self.context.source_image_hash, "roi_revision": 1, "geometry_revision": 0,
            "scope_signature": "scope-v1", "accepted_rois": [{"id": "roof", "revision": 1, "box_2d": [100, 100, 900, 900]}],
            "scopes": [{"roi_id": "roof", "outline_id": "outline", "polygons": [{"outer": rectangle(240, 160, 960, 640), "holes": []}]}]})
        self.provider.results = [ProviderResult(json.dumps(POLYGON)), ProviderResult(json.dumps([inlet()]))]
        first_outline = await OutlineService(self.service).generate(OWNER, outline)
        first_outlet = await OutletService(self.service).generate(OWNER, outlet)
        await self.restart()
        self.assertEqual(await OutlineService(self.service).generate(OWNER, outline), first_outline)
        self.assertEqual(await OutletService(self.service).generate(OWNER, outlet), first_outlet)
        self.assertTrue((await OutlineService(self.service).generate(OWNER, outline.model_copy(update={"request_id": "outline-cached"}))).run.cached)
        self.assertTrue((await OutletService(self.service).generate(OWNER, outlet.model_copy(update={"request_id": "outlet-cached"}))).run["cached"])
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.service.total_calls, 2)


if __name__ == "__main__":
    unittest.main()
