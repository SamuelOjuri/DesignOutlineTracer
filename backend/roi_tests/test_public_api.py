"""Exercise the deployed browser/API boundary without user authentication."""
import asyncio
from hashlib import sha256
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import httpx

from backend.app.config import Settings
from backend.app.main import PREFIX, create_app
from test_api import FakeProvider, TOKEN
from test_images import image_bytes


ORIGIN = "https://taperedplus.netlify.app"
HOST = "taperedplus-api.onrender.com"


class PublicApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = TemporaryDirectory()
        self.provider = FakeProvider()
        self.app = create_app(Settings(
            deployment_mode="public", allowed_origins=(ORIGIN,), allowed_hosts=(HOST,),
            state_path=str(Path(self.directory.name) / "roi.sqlite3"), max_http_requests=1,
        ), self.provider)
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, client=("198.51.100.10", 1234)),
            base_url=f"https://{HOST}", headers={**TOKEN, "Origin": ORIGIN},
        )
        self.image = image_bytes((100, 200))
        self.context = dict(document_id="document", file_name="plan.pdf", page_id="page", page_index=0,
                            source_image_hash=sha256(self.image).hexdigest(), source_width=100, source_height=200,
                            render_scale=2, render_rotation=0, render_version="pdfjs-test", pdf_view_box=[0, 0, 50, 100])

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.app.state.roi_service.close()
        self.directory.cleanup()

    async def upload(self, **kwargs):
        return await self.client.post(PREFIX + "/pages", data={"context": json.dumps(self.context)},
                                      files={"image": ("plan.png", self.image, "image/png")}, **kwargs)

    async def detect(self, **kwargs):
        return await self.client.post(PREFIX + "/pages/page/detections", json=dict(
            page_id="page", request_id="request", source_image_hash=self.context["source_image_hash"],
            task="roof_roi", roi_revision=None, geometry_revision=0,
        ), **kwargs)

    async def test_remote_browser_preflight_and_anonymous_editing_flow(self):
        preflight = await self.client.options(PREFIX + "/pages", headers={
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        })
        self.assertEqual(preflight.status_code, 200, preflight.text)
        self.assertEqual(preflight.headers["access-control-allow-origin"], ORIGIN)
        self.assertNotIn("access-control-allow-credentials", preflight.headers)
        uploaded = await self.upload()
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        detected = await self.detect()
        self.assertEqual(detected.status_code, 200, detected.text)
        self.assertEqual(detected.headers["access-control-allow-origin"], ORIGIN)
        self.assertEqual(len(self.provider.calls), 1)
        other = await self.detect(headers={"Authorization": "Bearer " + "b" * 64})
        self.assertEqual(other.status_code, 404)
        self.assertEqual((await self.client.delete(PREFIX + "/pages/page")).status_code, 204)

    async def test_unknown_origin_host_and_missing_page_ownership_are_rejected(self):
        denied = await self.upload(headers={"Origin": "https://unlisted.netlify.app"})
        self.assertEqual(denied.status_code, 403)
        self.assertEqual(denied.json()["error"]["code"], "origin_not_allowed")
        self.assertNotIn("access-control-allow-origin", denied.headers)
        denied = await self.client.get(PREFIX + "/health", headers={"Host": "unlisted.example"})
        self.assertEqual(denied.status_code, 400)
        denied = await self.upload(headers={"Authorization": ""})
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(denied.json()["error"]["code"], "session_token_required")
        self.assertEqual(self.provider.calls, [])

    async def test_public_health_requires_no_login_or_origin_and_stays_ready_under_load(self):
        self.assertEqual((await self.upload()).status_code, 200)
        self.provider.release.clear()
        detection = asyncio.create_task(self.detect())
        try:
            await asyncio.wait_for(self.provider.started.wait(), timeout=2)
            response = await self.client.get(PREFIX + "/health", headers={"Authorization": "", "Origin": ORIGIN})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["mode"], "public")
            self.assertEqual((await self.upload()).status_code, 429)
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=self.app, client=("203.0.113.1", 1234)),
                base_url=f"https://{HOST}",
            ) as health_client:
                self.assertEqual((await health_client.get(PREFIX + "/health")).status_code, 200)
        finally:
            self.provider.release.set()
            await detection

    async def test_local_development_mode_still_rejects_remote_clients(self):
        local_app = create_app(Settings(), FakeProvider())
        try:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=local_app, client=("198.51.100.10", 1234)),
                base_url="http://127.0.0.1",
            ) as client:
                response = await client.get(PREFIX + "/health")
                self.assertEqual(response.status_code, 403)
                self.assertEqual(response.json()["error"]["code"], "localhost_only")
        finally:
            await local_app.state.roi_service.close()
