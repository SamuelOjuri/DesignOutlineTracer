"""Deferred state commits keep the API responsive and precede paid provider calls."""
import asyncio
from contextlib import closing
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import threading
import time
import unittest
from unittest.mock import patch

from backend.app.config import Settings
from backend.app.errors import RoiError
from backend.app.images import prepare_image
from backend.app.models import DetectionInput, PageContext
from backend.app.outline_models import OutlineInput
from backend.app.outline_service import OutlineService
from backend.app.outlet_models import OutletInput
from backend.app.outlet_service import OutletService
from backend.app.service import RoiService
from test_api import FakeProvider
from test_images import image_bytes
from test_outlet_api import rectangle


OWNER = sha256(b"anonymous-remote-owner").hexdigest()


class DeferredStore:
    deferred = True
    healthy = True

    def __init__(self, database=None):
        self.database = database if database is not None else {"payload": None, "images": {}}
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.closed = False
        self.failures = 0
        self.writes = []
        self.active = 0
        self.max_active = 0
        self.writer_threads = []

    def load(self):
        return deepcopy(self.database["payload"]), dict(self.database["images"])

    def save(self, payload, images):
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.writer_threads.append(threading.get_ident())
        self.entered.set()
        try:
            if not self.release.wait(5):
                raise RuntimeError("test storage writer was not released")
            if self.failures:
                self.failures -= 1
                raise RuntimeError("private-postgres-url-and-server-secret")
            self.writes.append(deepcopy(payload))
            self.database.update(payload=deepcopy(payload), images=dict(images))
        finally:
            self.active -= 1

    def close(self):
        if self.active:
            raise RuntimeError("closed while a writer was active")
        self.closed = True


class RemoteServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.settings = Settings(state_path="unused-test-state.sqlite3")
        self.stores = []
        self.services = []
        self.source = image_bytes((1200, 800))
        self.context = PageContext(document_id="document", file_name="private.pdf", page_id="page", page_index=0,
            source_image_hash=sha256(self.source).hexdigest(), source_width=1200, source_height=800,
            render_scale=2.0, render_rotation=0, render_version="pdfjs-test", pdf_view_box=(0.0, 0.0, 600.0, 400.0))
        self.image = prepare_image(self.source, self.settings)
        self.service, self.provider, self.store = self.open_service()

    def open_service(self, database=None):
        store = DeferredStore(database)
        provider = FakeProvider()
        with patch("backend.app.service.StateStore", return_value=store):
            service = RoiService(self.settings, provider)
        self.services.append(service)
        self.stores.append(store)
        return service, provider, store

    async def asyncTearDown(self):
        for store in self.stores:
            store.release.set()
            store.failures = 0
        for service in self.services:
            await service.close()

    async def wait_for_writer(self):
        self.assertTrue(await asyncio.wait_for(asyncio.to_thread(self.store.entered.wait, 2), 3))

    def detection(self, **changes):
        return DetectionInput.model_validate({"page_id": "page", "request_id": "detection",
            "source_image_hash": self.context.source_image_hash, "task": "roof_roi", "roi_revision": None,
            "geometry_revision": 0, **changes})

    def outline(self):
        return OutlineInput.model_validate({"schema_version": "outline-1", "page_id": "page", "request_id": "outline",
            "source_image_hash": self.context.source_image_hash, "roi_revision": 1, "geometry_revision": 0,
            "roi": {"id": "roof", "revision": 1, "box_2d": [200, 200, 800, 800]},
            "boundary_policy": "inner_parapet", "boundary_notes": "", "vector_segments": []})

    def outlet(self):
        return OutletInput.model_validate({"contract_version": "outlet-1", "page_id": "page", "request_id": "outlet",
            "source_image_hash": self.context.source_image_hash, "roi_revision": 1, "geometry_revision": 0,
            "scope_signature": "scope-v1", "accepted_rois": [{"id": "roof", "revision": 1, "box_2d": [100, 100, 900, 900]}],
            "scopes": [{"roi_id": "roof", "outline_id": "outline", "polygons": [
                {"outer": rectangle(240, 160, 960, 640), "holes": []}]}]})

    async def test_remote_writes_are_offloaded_serialized_and_capture_detached_snapshots(self):
        self.service.upload(OWNER, self.context, self.image)
        self.assertIsNone(self.store.database["payload"])
        self.store.release.clear()
        first = asyncio.create_task(self.service.flush())
        await self.wait_for_writer()
        # This runs while save() is blocked in another thread.
        self.assertEqual(await asyncio.sleep(0, result="responsive"), "responsive")
        self.assertFalse(first.done())
        self.service.upload(OWNER, self.context.model_copy(update={"page_id": "second"}), self.image)
        second = asyncio.create_task(self.service.flush())
        await asyncio.sleep(0)
        self.assertEqual(self.store.max_active, 1)
        self.store.release.set()
        await asyncio.gather(first, second)
        self.assertEqual(set(self.store.writes[0]["sessions"][OWNER]["pages"]), {"page"})
        self.assertEqual(set(self.store.database["payload"]["sessions"][OWNER]["pages"]), {"page", "second"})
        self.assertEqual(self.store.max_active, 1)
        self.assertTrue(all(identifier != threading.get_ident() for identifier in self.store.writer_threads))

    async def test_supabase_credentials_auto_select_the_remote_store_without_a_local_disk(self):
        settings = Settings(supabase_url="https://example.supabase.co", supabase_secret_key="server-only-secret",
                            database_url="postgresql://backend:password@database.example.com/postgres",
                            storage_bucket="roof-pages")
        store = DeferredStore()
        self.stores.append(store)
        with patch("backend.app.service.SupabaseStateStore", return_value=store) as factory:
            service = RoiService(settings, FakeProvider())
        self.services.append(service)
        factory.assert_called_once_with("postgresql://backend:password@database.example.com/postgres",
                                        "https://example.supabase.co", "server-only-secret", "roof-pages",
                                        wall_clock=service.wall_clock)
        self.assertIs(service.store, store)
        self.assertIsNone(settings.state_path)

    async def test_repeated_cancellation_drains_writer_before_a_later_write_and_close(self):
        self.service.upload(OWNER, self.context, self.image)
        self.store.release.clear()
        first = asyncio.create_task(self.service.flush())
        await self.wait_for_writer()
        self.service.sessions[OWNER].calls = 4
        self.service.persist()
        second = asyncio.create_task(self.service.flush())
        first.cancel()
        await asyncio.sleep(0)
        first.cancel()
        await asyncio.sleep(0)
        self.assertFalse(first.done())
        self.assertFalse(second.done())
        self.assertEqual(self.store.active, 1)
        self.store.release.set()
        with self.assertRaises(asyncio.CancelledError):
            await first
        await second
        await self.service.close()
        self.assertTrue(self.store.closed)
        self.assertEqual(self.store.max_active, 1)
        self.assertEqual(self.store.database["payload"]["sessions"][OWNER]["calls"], 4)

    async def test_failed_reservations_never_reach_any_paid_provider_path(self):
        operations = [
            lambda: self.service.detect(OWNER, self.detection()),
            lambda: OutlineService(self.service).generate(OWNER, self.outline()),
            lambda: OutletService(self.service).generate(OWNER, self.outlet()),
        ]
        for operation in operations:
            with self.subTest(operation=operation):
                self.service.upload(OWNER, self.context, self.image)
                await self.service.flush()
                self.store.failures = 1
                with self.assertRaises(RoiError) as raised:
                    await operation()
                self.assertEqual((raised.exception.code, raised.exception.status), ("storage_unavailable", 503))
                self.assertNotIn("private-postgres", str(raised.exception))
                self.assertEqual(self.provider.calls, [])
        payload = self.store.database["payload"]
        self.assertEqual(payload["sessions"][OWNER]["calls"], 3)
        self.assertEqual(payload["total_calls"], 3)
        self.assertEqual(set(payload["sessions"][OWNER]["operations"]), {"detection", "outline", "outlet"})

    async def test_storage_health_reports_failure_until_a_commit_succeeds(self):
        self.service.upload(OWNER, self.context, self.image)
        self.store.failures = 1
        with self.assertRaisesRegex(RoiError, "^storage_unavailable$"):
            await self.service.flush()
        self.assertFalse(self.service.storage_available)
        await self.service.flush()
        self.assertTrue(self.service.storage_available)
        self.store.healthy = False
        self.assertFalse(self.service.storage_available)

    async def test_provider_sees_durable_reservation_and_restart_replays_completed_result(self):
        self.service.upload(OWNER, self.context, self.image)
        await self.service.flush()
        generate = self.provider.generate

        async def checked_generate(*args):
            payload = self.store.database["payload"]
            self.assertEqual(payload["total_calls"], 1)
            self.assertEqual(payload["sessions"][OWNER]["calls"], 1)
            self.assertTrue(payload["sessions"][OWNER]["operations"]["detection"]["interrupted"])
            return await generate(*args)

        self.provider.generate = checked_generate
        response = await self.service.detect(OWNER, self.detection())
        database = self.store.database
        self.assertIsNotNone(database["payload"]["sessions"][OWNER]["operations"]["detection"]["response"])
        await self.service.close()
        restored, provider, _store = self.open_service(database)
        self.assertEqual(await restored.detect(OWNER, self.detection()), response)
        self.assertEqual(provider.calls, [])
        self.assertEqual(restored.total_calls, 1)

    async def test_restart_prunes_missing_expired_page_bytes_but_retains_live_results_and_call_budget(self):
        self.service.upload(OWNER, self.context, self.image)
        await self.service.detect(OWNER, self.detection())
        self.service.upload(OWNER, self.context.model_copy(update={"page_id": "live"}), self.image)
        live_request = self.detection(page_id="live", request_id="live-request")
        live_response = await self.service.detect(OWNER, live_request)
        await self.service.close()
        database = self.store.database
        expired = database["payload"]["sessions"][OWNER]["pages"]["page"]
        expired["expires"] = time.time() - 1
        database["images"].pop(expired["upload_id"])

        restored, provider, store = self.open_service(database)
        with self.assertRaisesRegex(RoiError, "^page_not_found$"):
            restored.get_page(OWNER, "page")
        self.assertEqual((restored.total_calls, restored.sessions[OWNER].calls), (2, 2))
        self.assertEqual(await restored.detect(OWNER, live_request), live_response)
        self.assertEqual(provider.calls, [])
        retired = restored.sessions[OWNER].operations["detection"]
        self.assertIsNone(retired.response)
        self.assertIsNone(retired.error)
        self.assertFalse(retired.interrupted)
        await restored.flush()
        self.assertEqual(set(store.database["payload"]["sessions"][OWNER]["pages"]), {"live"})
        self.assertNotIn(expired["upload_id"], store.database["images"])

    async def test_restart_discards_expired_session_before_looking_up_its_missing_images(self):
        self.service.upload(OWNER, self.context, self.image)
        await self.service.detect(OWNER, self.detection())
        await self.service.close()
        database = self.store.database
        database["payload"]["sessions"][OWNER]["expires"] = time.time() - 1
        database["images"].clear()

        restored, provider, store = self.open_service(database)
        self.assertNotIn(OWNER, restored.sessions)
        self.assertEqual(restored.total_calls, 1)
        await restored.flush()
        self.assertEqual(store.database["payload"]["sessions"], {})
        self.assertEqual(provider.calls, [])

    async def test_sqlite_restart_durably_prunes_expired_records_with_missing_image_rows(self):
        with TemporaryDirectory() as directory:
            path = str(Path(directory) / "roi.sqlite3")
            settings = Settings(state_path=path)
            service = RoiService(settings, FakeProvider())
            service.upload(OWNER, self.context, self.image)
            await service.detect(OWNER, self.detection())
            await service.close()
            with closing(sqlite3.connect(path)) as connection:
                payload = json.loads(connection.execute("SELECT payload FROM state WHERE id = 1").fetchone()[0])
                payload["sessions"][OWNER]["pages"]["page"]["expires"] = time.time() - 1
                connection.execute("DELETE FROM images")
                connection.execute("UPDATE state SET payload = ? WHERE id = 1", (json.dumps(payload),))
                connection.commit()

            restored = RoiService(settings, FakeProvider())
            try:
                self.assertEqual((restored.total_calls, restored.sessions[OWNER].calls), (1, 1))
                self.assertEqual(restored.sessions[OWNER].pages, {})
                with closing(sqlite3.connect(path)) as connection:
                    durable = json.loads(connection.execute("SELECT payload FROM state WHERE id = 1").fetchone()[0])
                self.assertEqual(durable["sessions"][OWNER]["pages"], {})
                self.assertIsNone(durable["sessions"][OWNER]["operations"]["detection"]["response"])
            finally:
                await restored.close()


if __name__ == "__main__":
    unittest.main()
