"""Concurrency regressions exercise the HTTP boundary without live model traffic."""
import asyncio
from contextlib import closing
from copy import deepcopy
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import sqlite3
from tempfile import TemporaryDirectory
import threading
import unittest
from unittest.mock import patch

import httpx
from PIL import Image
from pydantic import ValidationError

from backend.app.config import Settings
from backend.app.errors import RoiError
from backend.app.gemini import ProviderResult
from backend.app.main import PREFIX, create_app
from backend.app.service import RoiService, Session
from test_api import FakeProvider, ROOF, TOKEN
from test_images import image_bytes


class PenetrationConcurrencyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.provider = FakeProvider()
        self.settings = Settings(penetration_crop_concurrency=2, max_provider_calls=2)
        self.app = create_app(self.settings, self.provider)
        self.service = self.app.state.roi_service
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=self.app, client=("127.0.0.1", 1234)),
            base_url="http://127.0.0.1", headers=TOKEN,
        )
        self.image = image_bytes((100, 200))
        self.context = dict(document_id="document", file_name="synthetic.pdf", page_id="page", page_index=0,
            source_image_hash=sha256(self.image).hexdigest(), source_width=100, source_height=200,
            render_scale=2, render_rotation=0, render_version="test", pdf_view_box=[0, 0, 50, 100])
        self.scope = {"roi_id": "roof", "outline_id": "scope-0", "outer": [
            {"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 200}, {"x": 0, "y": 200}]}
        self.assertEqual((await self.upload()).status_code, 200)

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.service.close()

    async def upload(self):
        return await self.client.post(PREFIX + "/pages", data={"context": json.dumps(self.context)},
            files={"image": ("plan.png", self.image, "image/png")})

    def scopes(self, count):
        return [{**deepcopy(self.scope), "outline_id": f"scope-{index}"} for index in range(count)]

    @staticmethod
    def crop_index(prompt):
        # Each crop's geometry, rather than response arrival order, identifies the fixture.
        for index in range(8):
            if f'"outline_id":"scope-{index}"' in prompt:
                return index
        raise AssertionError("Missing crop identity in model prompt")

    @staticmethod
    def record(index=0):
        left = 50 + index * 130
        return {"label": f"Riser {index}", "subtype": "riser", "roi_id": "roof",
                "box_2d": [200, left, 400, left + 70], "footprint": None}

    async def detect(self, **changes):
        request = dict(page_id="page", request_id="request", task="penetration", roi_revision=1,
            geometry_revision=1, source_image_hash=self.context["source_image_hash"],
            accepted_rois=[{"id": "roof", "revision": 1, "box_2d": [0, 0, 1000, 1000]}], scopes=self.scopes(2))
        request.update(changes)
        return await self.client.post(PREFIX + "/pages/page/detections", json=request)

    async def test_parallel_calls_are_bounded_and_merge_in_crop_order(self):
        gates = [asyncio.Event() for _ in range(4)]
        first_wave = asyncio.Event()
        active = peak = 0
        entered = []

        async def generate(image, prompt, schema, overview):
            nonlocal active, peak
            index = self.crop_index(prompt)
            entered.append(index)
            active += 1
            peak = max(peak, active)
            if len(entered) == 2:
                first_wave.set()
            try:
                await gates[index].wait()
                return ProviderResult(json.dumps([self.record(index)]))
            finally:
                active -= 1

        self.provider.generate_penetrations_with_context = generate
        pending = asyncio.create_task(self.detect(scopes=self.scopes(4)))
        try:
            await asyncio.wait_for(first_wave.wait(), 2)
            self.assertEqual(set(entered), {0, 1})
            gates[1].set()
            await asyncio.sleep(0)
            gates[0].set()
            gates[3].set()
            gates[2].set()
            response = await asyncio.wait_for(pending, 2)
        finally:
            for gate in gates:
                gate.set()
            if not pending.done():
                await pending
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(peak, 2)
        self.assertEqual(active, 0)
        self.assertEqual([item["outline_id"] for item in data["annotations"]], [f"scope-{i}" for i in range(4)])
        self.assertEqual([item["outline_id"] for item in data["run"]["settings"]["crops"]], [f"scope-{i}" for i in range(4)])
        self.assertEqual(data["run"]["provider_attempts"], 4)
        settings = data["run"]["settings"]
        self.assertEqual(settings["planned_crops"], 4)
        self.assertEqual(settings["completed_crops"], 4)
        self.assertEqual(settings["crop_failures"], [])
        self.assertEqual(set(settings["timings_ms"]), {"source_decode", "vector_index", "crop_preparation",
            "reservation_flush", "provider_queue", "model", "geometry", "elapsed"})
        self.assertTrue(all(value >= 0 for value in settings["timings_ms"].values()))
        self.assertTrue(all(crop["attempts"] == 1 for crop in settings["crops"]))
        replay = await self.detect(request_id="cached", scopes=self.scopes(4))
        self.assertTrue(replay.json()["run"]["cached"])
        self.assertEqual(replay.json()["run"]["provider_attempts"], 0)
        self.assertEqual(replay.json()["run"]["settings"], settings)
        self.assertEqual(len(entered), 4)

    async def test_initial_wave_reservations_are_flushed_before_any_provider_traffic(self):
        flushed_calls = []
        seen = []
        original_flush = self.service.flush

        async def flush():
            await original_flush()
            flushed_calls.append(self.service.total_calls)

        async def generate(image, prompt, schema, overview):
            seen.append((self.service.total_calls, flushed_calls[-1]))
            return ProviderResult("[]")

        self.service.flush = flush
        self.provider.generate_penetrations_with_context = generate
        response = await self.detect()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(seen, [(2, 2), (2, 2)])
        self.assertEqual(self.service.total_calls, 2)

    async def test_duplicate_winner_does_not_depend_on_reply_order(self):
        second_replied = asyncio.Event()

        async def generate(image, prompt, schema, overview):
            index = self.crop_index(prompt)
            if index == 0:
                await second_replied.wait()
            else:
                second_replied.set()
            return ProviderResult(json.dumps([{**self.record(), "label": f"From crop {index}"}]))

        self.provider.generate_penetrations_with_context = generate
        response = await asyncio.wait_for(self.detect(), 2)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual([(a["outline_id"], a["label"]) for a in response.json()["annotations"]],
                         [("scope-0", "From crop 0")])

    async def test_failed_first_crop_keeps_later_success_and_does_not_cache_partial(self):
        self.service.settings = self.settings.model_copy(update={"max_attempts": 1})
        calls = []

        async def generate(image, prompt, schema, overview):
            index = self.crop_index(prompt)
            calls.append(index)
            if index == 0:
                raise RoiError("permission_denied", 502)
            return ProviderResult(json.dumps([self.record(index)]))

        self.provider.generate_penetrations_with_context = generate
        response = await self.detect(scopes=self.scopes(3))
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "partial")
        self.assertIn("penetration_crop_failed", data["warnings"])
        self.assertEqual([item["outline_id"] for item in data["annotations"]], ["scope-1", "scope-2"])
        self.assertEqual(data["run"]["provider_attempts"], 3)
        self.assertFalse(data["run"]["settings"]["coverage_complete"])
        repeated = await self.detect(request_id="new-attempt", scopes=self.scopes(3))
        self.assertFalse(repeated.json()["run"]["cached"])
        self.assertEqual(len(calls), 6)

    async def test_every_crop_failure_returns_provider_error_and_releases_operation_slot(self):
        self.service.settings = self.settings.model_copy(update={"max_attempts": 1})

        async def generate(image, prompt, schema, overview):
            raise RoiError("provider_refusal", 502)

        self.provider.generate_penetrations_with_context = generate
        response = await self.detect()
        self.assertEqual(response.status_code, 502, response.text)
        self.assertEqual(response.json()["error"]["code"], "provider_refusal")
        self.assertEqual(self.service.active_calls, 0)

    async def test_retry_cannot_consume_another_crops_reserved_first_attempt(self):
        self.service.settings = self.settings.model_copy(update={"max_calls_per_session": 2})
        calls = []

        async def generate(image, prompt, schema, overview):
            index = self.crop_index(prompt)
            calls.append(index)
            return ProviderResult("malformed" if index == 0 else json.dumps([self.record(index)]))

        self.provider.generate_penetrations_with_context = generate
        response = await self.detect()
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "partial")
        self.assertIn("penetration_call_budget_reached", data["warnings"])
        self.assertEqual([item["outline_id"] for item in data["annotations"]], ["scope-1"])
        self.assertEqual(sorted(calls), [0, 1])
        self.assertEqual(data["run"]["provider_attempts"], 2)
        self.assertEqual(self.service.total_calls, 2)

    async def test_timeout_preserves_other_crop_and_releases_provider_capacity(self):
        self.service.settings = self.settings.model_copy(update={"penetration_call_timeout_seconds": .03, "max_attempts": 1})
        cancelled = asyncio.Event()

        async def generate(image, prompt, schema, overview):
            index = self.crop_index(prompt)
            if index == 0:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.set()
                    raise
            return ProviderResult(json.dumps([self.record(index)]))

        self.provider.generate_penetrations_with_context = generate
        response = await asyncio.wait_for(self.detect(), 2)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "partial")
        self.assertTrue(cancelled.is_set())
        self.assertEqual([a["outline_id"] for a in response.json()["annotations"]], ["scope-1"])
        self.assertEqual(self.service.active_calls, 0)

        async def recovered(image, prompt, schema, overview):
            return ProviderResult(json.dumps([self.record(self.crop_index(prompt))]))

        self.provider.generate_penetrations_with_context = recovered
        recovered_response = await self.detect(request_id="recovered")
        self.assertEqual(recovered_response.json()["status"], "complete")

    async def test_malformed_crop_retries_once_with_its_own_budgeted_attempt(self):
        self.service.settings = self.settings.model_copy(update={"max_calls_per_session": 3})
        calls = []

        async def generate(image, prompt, schema, overview):
            index = self.crop_index(prompt)
            calls.append(index)
            if index == 0 and calls.count(0) == 1:
                return ProviderResult("malformed")
            return ProviderResult(json.dumps([self.record(index)]))

        self.provider.generate_penetrations_with_context = generate
        response = await self.detect()
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "complete")
        self.assertEqual(sorted(calls), [0, 0, 1])
        self.assertEqual(self.service.total_calls, 3)
        self.assertEqual(data["run"]["provider_attempts"], 3)
        self.assertEqual([crop["attempts"] for crop in data["run"]["settings"]["crops"]], [2, 1])

    async def test_annotation_limit_stops_queued_waves(self):
        self.service.settings = self.settings.model_copy(update={"max_annotations": 1})
        calls = []

        async def generate(image, prompt, schema, overview):
            index = self.crop_index(prompt)
            calls.append(index)
            return ProviderResult(json.dumps([self.record(index)]))

        self.provider.generate_penetrations_with_context = generate
        response = await self.detect(scopes=self.scopes(5))
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(len(data["annotations"]), 1)
        self.assertEqual(data["annotations"][0]["outline_id"], "scope-0")
        self.assertIn("penetration_annotation_limit_reached", data["warnings"])
        self.assertEqual(sorted(calls), [0, 1])
        self.assertEqual(data["run"]["provider_attempts"], 2)

    async def test_page_delete_cancels_active_crop_calls_without_starting_queued_crops(self):
        started = asyncio.Event()
        active = 0
        cancelled = []
        calls = []

        async def generate(image, prompt, schema, overview):
            nonlocal active
            index = self.crop_index(prompt)
            calls.append(index)
            active += 1
            if active == 2:
                started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.append(index)
                raise
            finally:
                active -= 1

        self.provider.generate_penetrations_with_context = generate
        pending = asyncio.create_task(self.detect(scopes=self.scopes(4)))
        await asyncio.wait_for(started.wait(), 2)
        deleted = await self.client.delete(PREFIX + "/pages/page")
        self.assertEqual(deleted.status_code, 204)
        response = await asyncio.wait_for(pending, 2)
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(sorted(cancelled), [0, 1])
        self.assertEqual(sorted(calls), [0, 1])
        self.assertEqual(active, 0)
        self.assertEqual(self.service.active_calls, 0)

    async def test_provider_capacity_is_shared_with_full_page_detection(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        generic_entered = asyncio.Event()
        active = peak = 0

        async def tracked(result, generic=False):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            if generic:
                generic_entered.set()
            if active == 2:
                entered.set()
            try:
                await release.wait()
                return result
            finally:
                active -= 1

        async def penetration(image, prompt, schema, overview):
            return await tracked(ProviderResult(json.dumps([self.record(self.crop_index(prompt))])))

        async def generic(image, prompt, schema):
            return await tracked(ProviderResult(ROOF), generic=True)

        self.provider.generate_penetrations_with_context = penetration
        self.provider.generate = generic
        pending = asyncio.create_task(self.detect())
        await asyncio.wait_for(entered.wait(), 2)
        other = asyncio.create_task(self.detect(request_id="roof-request", task="roof_roi",
            roi_revision=None, accepted_rois=[], scopes=[]))
        try:
            await asyncio.sleep(.02)
            self.assertFalse(generic_entered.is_set())
        finally:
            release.set()
        first, second = await asyncio.wait_for(asyncio.gather(pending, other), 2)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertTrue(generic_entered.is_set())
        self.assertEqual(peak, 2)
        self.assertEqual(active, 0)

    async def test_delete_drains_geometry_worker_before_closing_its_raster(self):
        from backend.app.penetration_geometry import annotations_from_proposals

        entered = threading.Event()
        release = threading.Event()
        source_accessible = []

        def slow_geometry(proposals, page, crop, scope, vectors=(), source=None):
            entered.set()
            release.wait(2)
            try:
                source.gray.getpixel((0, 0))
                source_accessible.append(True)
            except ValueError:
                source_accessible.append(False)
            return annotations_from_proposals(proposals, page, crop, scope, vectors, source)

        async def generate(image, prompt, schema, overview):
            return ProviderResult(json.dumps([self.record()]))

        self.provider.generate_penetrations_with_context = generate
        with patch("backend.app.penetration_service.annotations_from_proposals", side_effect=slow_geometry):
            pending = asyncio.create_task(self.detect(scopes=self.scopes(1)))
            try:
                self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                deleted = await self.client.delete(PREFIX + "/pages/page")
                self.assertEqual(deleted.status_code, 204)
                await asyncio.sleep(.02)
                self.assertFalse(pending.done(), "The raster owner must wait for a cancelled CPU worker")
            finally:
                release.set()
            response = await asyncio.wait_for(pending, 2)
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(source_accessible, [True])
        self.assertEqual(self.service.active_calls, 0)

    async def test_scan_deadline_preserves_completed_wave_and_cancels_remaining_calls(self):
        self.service.settings = self.settings.model_copy(update={"timeout_seconds": .25})
        cancelled = []

        async def generate(image, prompt, schema, overview):
            index = self.crop_index(prompt)
            if index >= 2:
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    cancelled.append(index)
                    raise
            return ProviderResult(json.dumps([self.record(index)]))

        self.provider.generate_penetrations_with_context = generate
        response = await asyncio.wait_for(self.detect(scopes=self.scopes(4)), 2)
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["status"], "partial")
        self.assertIn("penetration_scan_time_limit_reached", data["warnings"])
        self.assertEqual([a["outline_id"] for a in data["annotations"]], ["scope-0", "scope-1"])
        self.assertEqual(data["run"]["settings"]["completed_crops"], 2)
        self.assertEqual(data["run"]["settings"]["crop_failures"], [
            {"index": 2, "code": "provider_timeout"}, {"index": 3, "code": "provider_timeout"}])
        self.assertEqual(sorted(cancelled), [2, 3])
        self.assertEqual(data["run"]["provider_attempts"], 4)
        self.assertEqual(self.service.active_calls, 0)


class BoundedCpuCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_repeated_cancellation_waits_for_the_real_worker_to_exit(self):
        from backend.app.outline_service import bounded_cpu

        entered = threading.Event()
        release = threading.Event()
        exited = threading.Event()

        def work():
            entered.set()
            try:
                release.wait(2)
            finally:
                exited.set()

        worker = asyncio.create_task(bounded_cpu(work))
        try:
            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
            worker.cancel()
            await asyncio.sleep(0)
            worker.cancel()
            await asyncio.sleep(.02)
            self.assertFalse(worker.done(), "Cancellation must not release live raster/capacity owners")
            self.assertFalse(exited.is_set())
        finally:
            release.set()
            await asyncio.gather(worker, return_exceptions=True)
        self.assertTrue(exited.is_set())
        self.assertTrue(worker.cancelled())


class PenetrationPerformanceSettingsTests(unittest.TestCase):
    def test_defaults_keep_accuracy_limits_and_bound_parallel_traffic(self):
        settings = Settings()
        self.assertEqual(settings.penetration_crop_concurrency, 4)
        self.assertEqual(settings.max_provider_calls, 4)
        self.assertEqual(settings.penetration_call_timeout_seconds, 120)
        self.assertEqual(settings.max_annotations, 25)
        self.assertEqual(settings.thinking_level, "medium")

    def test_parallel_settings_reject_zero_excessive_and_nonfinite_values(self):
        invalid = {"penetration_crop_concurrency": [0, -1, 9, 1.5],
                   "max_provider_calls": [0, -1, 17, 1.5],
                   "penetration_call_timeout_seconds": [0, -1, 901, float("nan"), float("inf")]}
        for field, values in invalid.items():
            for value in values:
                with self.subTest(field=field, value=value), self.assertRaises(ValidationError):
                    Settings(**{field: value})

    def test_environment_loads_independent_crop_provider_and_timeout_limits(self):
        with patch.dict("os.environ", {"ROI_PENETRATION_CROP_CONCURRENCY": "2",
            "ROI_MAX_PROVIDER_CALLS": "3", "ROI_PENETRATION_CALL_TIMEOUT_SECONDS": "45"}, clear=True):
            settings = Settings.from_env()
        self.assertEqual(settings.penetration_crop_concurrency, 2)
        self.assertEqual(settings.max_provider_calls, 3)
        self.assertEqual(settings.penetration_call_timeout_seconds, 45)
        self.assertEqual(settings.outlet_call_timeout_seconds, 120)


class BatchReservationPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_is_one_sqlite_commit_and_survives_restart_without_refunding_calls(self):
        with TemporaryDirectory() as directory:
            path = str(Path(directory) / "roi.sqlite3")
            settings = Settings(state_path=path, max_calls_per_session=5, max_total_calls=3)
            clock = lambda: 100.
            wall_clock = lambda: 1000.
            service = RoiService(settings, FakeProvider(), clock, wall_clock)
            try:
                first, second = Session(expires=200), Session(expires=200)
                service.sessions.update(first=first, second=second)
                with patch.object(service.store, "save", wraps=service.store.save) as saved:
                    self.assertEqual(service.reserve_calls(first, 2), 2)
                    self.assertEqual(saved.call_count, 1)
                    self.assertEqual(service.reserve_calls(second, 4), 1)
                    self.assertEqual(saved.call_count, 2)
                    self.assertEqual(service.reserve_calls(first, 1), 0)
                    self.assertEqual(saved.call_count, 2)
                with closing(sqlite3.connect(path)) as database:
                    state = json.loads(database.execute("SELECT payload FROM state").fetchone()[0])
                self.assertEqual(state["total_calls"], 3)
                self.assertEqual(state["sessions"]["first"]["calls"], 2)
                self.assertEqual(state["sessions"]["second"]["calls"], 1)
            finally:
                await service.close()
            restarted = RoiService(settings, FakeProvider(), clock, wall_clock)
            try:
                self.assertEqual(restarted.total_calls, 3)
                self.assertEqual(restarted.sessions["first"].calls, 2)
                self.assertEqual(restarted.sessions["second"].calls, 1)
                self.assertEqual(restarted.reserve_calls(restarted.sessions["first"], 1), 0)
            finally:
                await restarted.close()


class CropPreparationCompatibilityTests(unittest.TestCase):
    def test_rgb_png_transparency_preserves_original_white_compositing(self):
        from backend.app.outline_geometry import OutlineCropSource, prepare_outline_crop

        output = BytesIO()
        with Image.new("RGB", (100, 100), (19, 37, 53)) as image:
            image.save(output, format="PNG", transparency=(19, 37, 53))
        original = output.getvalue()
        expected = prepare_outline_crop(original, [0, 0, 1000, 1000])
        source = OutlineCropSource(original)
        actual = None
        try:
            actual = source.prepare([0, 0, 1000, 1000])
            self.assertEqual(actual.png, expected.png)
            self.assertEqual(actual.source.gray.tobytes(), expected.source.gray.tobytes())
        finally:
            source.close()
            expected.source.gray.close()
            if actual is not None:
                actual.source.gray.close()
