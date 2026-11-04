"""Render can promote a standby process before the old PostgreSQL writer exits."""
import asyncio
from hashlib import sha256
import json
import threading
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

from backend.app.config import Settings
from backend.app.main import PREFIX, create_app
from backend.app.service import RoiService as RealRoiService
from backend.app.supabase_storage import SupabaseWriterBusy
from test_api import FakeProvider, TOKEN
from test_images import image_bytes


class SupabaseStartupTests(unittest.IsolatedAsyncioTestCase):
    def settings(self):
        return Settings(deployment_mode="public", allowed_origins=("https://roof.netlify.app",),
                        allowed_hosts=("roof-api.onrender.com",),
                        supabase_url="https://example.supabase.co", supabase_secret_key="server-only-secret",
                        database_url="postgresql://backend:password@database.example.com/postgres")

    def client(self, application):
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=application, client=("203.0.113.1", 1234)),
                                base_url="https://roof-api.onrender.com",
                                headers={**TOKEN, "Origin": "https://roof.netlify.app"})

    async def wait_until(self, predicate, timeout=3):
        async with asyncio.timeout(timeout):
            while not predicate():
                await asyncio.sleep(0.005)

    async def test_standby_liveness_is_healthy_while_api_rejects_traffic_with_retry_after(self):
        with patch("backend.app.main.RoiService", side_effect=SupabaseWriterBusy()):
            application = create_app(self.settings(), FakeProvider())
        async with self.client(application) as client:
            liveness = await client.get("/healthz")
            self.assertEqual(liveness.status_code, 200)
            self.assertEqual(liveness.json()["status"], "standby")
            for response in [await client.get(PREFIX + "/health"), await client.post(PREFIX + "/pages", content=b"")]:
                self.assertEqual(response.status_code, 503)
                self.assertTrue(response.headers.get("Retry-After", "").isdigit())
                self.assertNotIn("server-only-secret", response.text)

    async def test_releasing_old_writer_automatically_enables_the_new_anonymous_api(self):
        released = threading.Event()
        provider = FakeProvider()
        active = RealRoiService(Settings(), provider)
        attempts = []

        def factory(*_args, **_kwargs):
            attempts.append(threading.get_ident())
            if not released.is_set():
                raise SupabaseWriterBusy()
            return active

        try:
            with patch("backend.app.main.RoiService", side_effect=factory), \
                    patch("backend.app.main.STORAGE_ACTIVATION_RETRY_SECONDS", 0.005):
                application = create_app(self.settings(), provider)
                async with application.router.lifespan_context(application):
                    async with self.client(application) as client:
                        self.assertEqual((await client.get("/healthz")).json()["status"], "standby")
                        self.assertEqual((await client.get(PREFIX + "/health")).status_code, 503)
                        released.set()
                        await self.wait_until(lambda: getattr(application.state, "roi_service", None) is active)
                        response = await client.get(PREFIX + "/health")
                        self.assertEqual(response.status_code, 200)
                        self.assertEqual(response.json()["status"], "ready")

                        image = image_bytes((100, 200))
                        context = dict(document_id="document", file_name="private.pdf", page_id="page", page_index=0,
                            source_image_hash=sha256(image).hexdigest(), source_width=100, source_height=200,
                            render_scale=2, render_rotation=0, render_version="pdfjs-test", pdf_view_box=[0, 0, 50, 100])
                        upload = await client.post(PREFIX + "/pages", data={"context": json.dumps(context)},
                            files={"image": ("source-page.png", image, "image/png")})
                        self.assertEqual(upload.status_code, 200)
                        detection = await client.post(PREFIX + "/pages/page/detections", json=dict(page_id="page",
                            request_id="request", source_image_hash=context["source_image_hash"], task="roof_roi",
                            roi_revision=None, geometry_revision=0))
                        self.assertEqual(detection.status_code, 200)
                        self.assertEqual(detection.json()["status"], "complete")
                        self.assertEqual(len(provider.calls), 1)
            self.assertGreaterEqual(len(attempts), 2)
            self.assertTrue(any(identifier != threading.get_ident() for identifier in attempts[1:]))
        finally:
            await active.close()

    async def test_invalid_storage_configuration_fails_instead_of_entering_standby(self):
        with patch("backend.app.main.RoiService", side_effect=RuntimeError("migration missing")):
            with self.assertRaisesRegex(RuntimeError, "migration missing"):
                create_app(self.settings(), FakeProvider())

    async def test_standby_timeout_marks_deployment_unhealthy(self):
        provider = FakeProvider()
        with patch("backend.app.main.RoiService", side_effect=SupabaseWriterBusy()), \
                patch("backend.app.main.STORAGE_ACTIVATION_TIMEOUT_SECONDS", 0.02), \
                patch("backend.app.main.STORAGE_ACTIVATION_RETRY_SECONDS", 0.005):
            application = create_app(self.settings(), provider)
            async with application.router.lifespan_context(application):
                async with self.client(application) as client:
                    async with asyncio.timeout(2):
                        while (response := await client.get("/healthz")).status_code != 503:
                            await asyncio.sleep(0.005)
                    self.assertEqual(response.json()["error"]["code"], "storage_unavailable")
                    self.assertEqual((await client.get(PREFIX + "/health")).status_code, 503)
                    self.assertIsNone(application.state.roi_service)
        self.assertTrue(provider.closed)

    async def test_unexpected_activation_failure_marks_deployment_unhealthy_without_leaking_details(self):
        provider = FakeProvider()
        with patch("backend.app.main.RoiService", side_effect=[SupabaseWriterBusy(), RuntimeError("private-database-credential")]):
            application = create_app(self.settings(), provider)
            async with application.router.lifespan_context(application):
                async with self.client(application) as client:
                    async with asyncio.timeout(2):
                        while (response := await client.get("/healthz")).status_code != 503:
                            await asyncio.sleep(0.005)
                    self.assertEqual(response.json()["error"]["code"], "storage_unavailable")
                    self.assertNotIn("private-database-credential", response.text)
                    self.assertIsNone(application.state.roi_service)
        self.assertTrue(provider.closed)

    async def test_api_is_not_enabled_until_candidate_startup_flush_commits(self):
        provider = FakeProvider()
        active = RealRoiService(Settings(), provider)
        committing, release = asyncio.Event(), asyncio.Event()
        original_flush = active.flush

        async def flush():
            committing.set()
            await release.wait()
            await original_flush()

        active.flush = flush
        try:
            with patch("backend.app.main.RoiService", side_effect=[SupabaseWriterBusy(), active]):
                application = create_app(self.settings(), provider)
                async with application.router.lifespan_context(application):
                    await asyncio.wait_for(committing.wait(), 2)
                    async with self.client(application) as client:
                        self.assertEqual((await client.get("/healthz")).status_code, 200)
                        self.assertEqual((await client.get(PREFIX + "/health")).status_code, 503)
                        self.assertIsNone(application.state.roi_service)
                        release.set()
                        await self.wait_until(lambda: application.state.roi_service is active)
                        self.assertEqual((await client.get(PREFIX + "/health")).status_code, 200)
        finally:
            release.set()
            await active.close()

    async def test_failed_candidate_flush_and_close_cannot_leave_liveness_healthy(self):
        candidate = MagicMock()
        candidate.flush = AsyncMock(side_effect=RuntimeError("private-write-detail"))
        candidate.close = AsyncMock(side_effect=RuntimeError("private-close-detail"))
        with patch("backend.app.main.RoiService", side_effect=[SupabaseWriterBusy(), candidate]):
            application = create_app(self.settings(), FakeProvider())
            async with application.router.lifespan_context(application):
                async with self.client(application) as client:
                    async with asyncio.timeout(2):
                        while (response := await client.get("/healthz")).status_code != 503:
                            await asyncio.sleep(0.005)
                    self.assertNotIn("private-", response.text)
                    self.assertIsNone(application.state.roi_service)
        candidate.close.assert_awaited_once()

    async def test_activation_deadline_fails_health_even_while_constructor_thread_is_blocked(self):
        provider = FakeProvider()
        active = RealRoiService(Settings(), provider)
        entered, release = threading.Event(), threading.Event()
        calls = 0

        def factory(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise SupabaseWriterBusy()
            entered.set()
            if not release.wait(3):
                raise RuntimeError("test constructor was not released")
            return active

        try:
            with patch("backend.app.main.RoiService", side_effect=factory), \
                    patch("backend.app.main.STORAGE_ACTIVATION_TIMEOUT_SECONDS", 0.02):
                application = create_app(self.settings(), provider)
                async with application.router.lifespan_context(application):
                    self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                    async with self.client(application) as client:
                        async with asyncio.timeout(1):
                            while (response := await client.get("/healthz")).status_code != 503:
                                await asyncio.sleep(0.005)
                        self.assertFalse(release.is_set())
                        release.set()
                        await self.wait_until(lambda: provider.closed)
                        self.assertIsNone(application.state.roi_service)
        finally:
            release.set()
            await active.close()

    async def test_initial_startup_flush_failure_closes_the_storage_owner(self):
        initial = MagicMock()
        initial.flush = AsyncMock(side_effect=RuntimeError("write failed"))
        initial.close = AsyncMock()
        with patch("backend.app.main.RoiService", return_value=initial):
            application = create_app(self.settings(), FakeProvider())
            with self.assertRaisesRegex(RuntimeError, "write failed"):
                async with application.router.lifespan_context(application):
                    self.fail("failed startup must not serve requests")
        initial.close.assert_awaited_once()

    async def test_shutdown_drains_a_background_constructor_and_closes_its_writer(self):
        provider = FakeProvider()
        active = RealRoiService(Settings(), provider)
        entered, release = threading.Event(), threading.Event()
        calls = 0

        def factory(*_args, **_kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise SupabaseWriterBusy()
            entered.set()
            if not release.wait(5):
                raise RuntimeError("test constructor was not released")
            return active

        try:
            with patch("backend.app.main.RoiService", side_effect=factory):
                application = create_app(self.settings(), provider)
                lifespan = application.router.lifespan_context(application)
                await lifespan.__aenter__()
                self.assertTrue(await asyncio.wait_for(asyncio.to_thread(entered.wait, 2), 3))
                shutdown = asyncio.create_task(lifespan.__aexit__(None, None, None))
                await asyncio.sleep(0.01)
                self.assertFalse(shutdown.done())
                self.assertFalse(provider.closed)
                release.set()
                await asyncio.wait_for(shutdown, 2)
                self.assertTrue(provider.closed)
                self.assertIsNone(application.state.roi_service)
        finally:
            release.set()
            await active.close()


if __name__ == "__main__":
    unittest.main()
