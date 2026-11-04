"""Storage protocol tests with transactional DB state and the real HTTPX transport."""
from copy import deepcopy
import json
import unittest
from urllib.parse import unquote

import httpx

from backend.app.supabase_storage import SupabaseStateStore, SupabaseWriterBusy


class Rows:
    def __init__(self, rows=()):
        self.rows = list(rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeDatabase:
    def __init__(self):
        self.state = None
        self.images = {}
        self.outbox = set()
        self.owner = None
        self.connections = []
        self.connect_options = []
        self.fail_preflight = False
        self.lock_attempts = 0

    def connect(self, _url, **kwargs):
        self.connect_options.append(kwargs)
        connection = FakeConnection(self, len(self.connections) + 1)
        self.connections.append(connection)
        return connection


class Transaction:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        database = self.connection.database
        self.before = deepcopy((database.state, database.images, database.outbox))

    def __exit__(self, kind, error, trace):
        if error is not None:
            database = self.connection.database
            database.state, database.images, database.outbox = self.before


class FakeConnection:
    closed = False
    broken = False
    fail_snapshot = False

    def __init__(self, database, pid):
        self.database, self.pid = database, pid

    def transaction(self):
        return Transaction(self)

    def execute(self, query, params=()):
        query = " ".join(query.split())
        database = self.database
        if self.closed or self.broken:
            raise RuntimeError("sensitive connection failure")
        if query.startswith("SET "):
            return Rows()
        if "pg_try_advisory_lock" in query:
            database.lock_attempts += 1
            acquired = database.owner in (None, self.pid)
            if acquired:
                database.owner = self.pid
            return Rows([(self.pid, acquired)])
        if query.startswith("SELECT pg_backend_pid(), EXISTS"):
            return Rows([(self.pid, database.owner == self.pid)])
        if database.fail_preflight and query.startswith("SELECT "):
            raise RuntimeError("missing migration column")
        if query.startswith("INSERT INTO roi.state"):
            if database.state is None:
                database.state = {"bucket": params[0], "prefix": params[1], "payload": None}
        elif query.startswith("SELECT bucket, prefix, payload"):
            return Rows([(database.state["bucket"], database.state["prefix"], deepcopy(database.state["payload"]))]) if database.state else Rows()
        elif query.startswith("SELECT bucket, prefix"):
            return Rows([(database.state["bucket"], database.state["prefix"])])
        elif query.startswith("SELECT payload"):
            return Rows([(deepcopy(database.state["payload"]),)])
        elif query.startswith("SELECT upload_id, source_key"):
            if query.endswith("LIMIT 0"):
                return Rows()
            return Rows([(key, *value) for key, value in database.images.items()])
        elif query.startswith("SELECT object_key, created_at"):
            return Rows()
        elif query.startswith("SELECT pending.object_key"):
            referenced = {key for image in database.images.values() for key in image[:2]}
            return Rows([(key,) for key in sorted(database.outbox - referenced)[:1000]])
        elif query.startswith("INSERT INTO roi.delete_outbox"):
            database.outbox.add(params[0])
        elif query.startswith("DELETE FROM roi.delete_outbox"):
            database.outbox.difference_update(params[0])
        elif query.startswith("INSERT INTO roi.images"):
            database.images[params[0]] = params[1:]
        elif query.startswith("DELETE FROM roi.images"):
            database.images.pop(params[0])
        elif query.startswith("UPDATE roi.state"):
            database.state["payload"] = json.loads(params[0])
            if self.fail_snapshot:
                self.fail_snapshot = False
                raise RuntimeError("commit failed with a secret database URL")
        else:
            raise AssertionError(f"Unsupported query in transactional fake: {query}")
        return Rows()

    def close(self):
        self.closed = True
        if self.database.owner == self.pid:
            self.database.owner = None


class FakeStorage:
    def __init__(self):
        self.objects = {"unrelated/logo.png": b"another application's image"}
        self.public = False
        self.fail_delete = 0
        self.fail_post_number = None
        self.posts = 0
        self.requests = []
        self.required_key = None

    def request(self, request):
        self.requests.append(request)
        if self.required_key is not None and request.headers.get("apikey") != self.required_key:
            return httpx.Response(401)
        path = unquote(request.url.path).removeprefix("/storage/v1")
        if path.startswith("/bucket/"):
            return httpx.Response(200, json={"id": path.split("/")[-1], "public": self.public})
        if request.method == "POST":
            self.posts += 1
            if self.posts == self.fail_post_number:
                return httpx.Response(503)
            key = path.split("/", 3)[3]
            if key in self.objects:
                return httpx.Response(409)
            self.objects[key] = request.content
            return httpx.Response(200, json={"Key": key})
        if request.method == "DELETE":
            if self.fail_delete:
                self.fail_delete -= 1
                return httpx.Response(503)
            for key in json.loads(request.content)["prefixes"]:
                self.objects.pop(key, None)
            return httpx.Response(200, json=[])
        if request.method == "GET":
            key = path.split("/", 4)[4]
            return httpx.Response(200, content=self.objects[key]) if key in self.objects else httpx.Response(404)
        raise AssertionError("Unexpected Storage API request")

    def client(self):
        return httpx.Client(transport=httpx.MockTransport(self.request))


class SupabaseStorageTests(unittest.TestCase):
    def setUp(self):
        self.database = FakeDatabase()
        self.storage = FakeStorage()
        self.stores = []
        self.wall = 1_000_000.0

    def tearDown(self):
        for store in self.stores:
            store.close()

    def store(self, key="sb_secret_test", bucket="roi-pages", database_url="postgresql://backend:password@db.example.com/postgres"):
        store = SupabaseStateStore(database_url, "https://project.supabase.co",
            key, bucket, connection_factory=self.database.connect, http_client=self.storage.client(), wall_clock=lambda: self.wall)
        self.stores.append(store)
        return store

    def test_save_restart_round_trip_uploads_immutable_images_only_once(self):
        store = self.store()
        images = {"upload_1": (b"rendered-source-page", b"inference-png")}
        store.save({"version": 1, "calls": 1}, images)
        store.save({"version": 1, "calls": 2}, images)
        self.assertEqual(self.storage.posts, 2)
        self.assertEqual(self.database.outbox, set())
        self.assertEqual(self.database.connect_options[0]["sslmode"], "require")
        for request in self.storage.requests:
            self.assertEqual(request.headers["apikey"], "sb_secret_test")
            self.assertNotIn("Authorization", request.headers)
        store.close()
        restored = self.store()
        self.assertEqual(restored.load(), ({"version": 1, "calls": 2}, images))
        self.assertEqual(self.storage.posts, 2)
        self.assertTrue(restored.healthy)

    def test_legacy_service_role_jwt_uses_bearer(self):
        store = self.store(key="eyJ.legacy.service_role")
        self.assertEqual(self.storage.requests[0].headers["Authorization"], "Bearer eyJ.legacy.service_role")
        self.assertTrue(store.healthy)

    def test_public_bucket_and_namespace_changes_fail_closed(self):
        self.storage.public = True
        with self.assertRaisesRegex(RuntimeError, "initialization failed"):
            self.store()
        self.assertIsNone(self.database.owner)
        self.storage.public = False
        self.store().close()
        with self.assertRaisesRegex(RuntimeError, "initialization failed"):
            self.store(bucket="another-bucket")
        self.assertEqual(self.storage.objects, {"unrelated/logo.png": b"another application's image"})

    def test_second_writer_and_lost_ownership_cannot_write_or_reconnect(self):
        store = self.store()
        with self.assertRaisesRegex(SupabaseWriterBusy, "single-writer"):
            self.store()
        self.assertTrue(self.database.connections[-1].closed)
        self.assertTrue(store.healthy)
        self.database.owner = None  # Model pg_advisory_unlock_all/session loss.
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.save({"version": 1}, {"upload": (b"a", b"b")})
        self.assertFalse(store.healthy)
        self.assertEqual(self.storage.posts, 0)
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.load()
        self.assertEqual(len(self.database.connections), 2)

    def test_invalid_preflight_never_reports_a_validated_busy_writer(self):
        self.store()
        original_binding = deepcopy(self.database.state)
        for failure in ("credentials", "public_bucket", "schema", "namespace", "state_version"):
            with self.subTest(failure=failure):
                self.storage.required_key = "different_key" if failure == "credentials" else None
                self.storage.public = failure == "public_bucket"
                self.database.fail_preflight = failure == "schema"
                self.database.state = deepcopy(original_binding)
                if failure == "namespace":
                    self.database.state["bucket"] = "another-project-bucket"
                if failure == "state_version":
                    self.database.state["payload"] = {"version": 2}
                attempts = self.database.lock_attempts
                with self.assertRaisesRegex(RuntimeError, "initialization failed") as caught:
                    self.store()
                self.assertNotIsInstance(caught.exception, SupabaseWriterBusy)
                self.assertEqual(self.database.lock_attempts, attempts)
                self.assertTrue(self.database.connections[-1].closed)
        self.database.state = original_binding

    def test_obvious_project_ref_mismatch_is_rejected_before_busy(self):
        self.store()
        for database_url in (
            "postgresql://postgres:password@db.differentproject.supabase.co/postgres",
            "postgresql://postgres.differentproject:password@aws-0-region.pooler.supabase.com/postgres",
        ):
            with self.subTest(database_url=database_url):
                with self.assertRaisesRegex(RuntimeError, "initialization failed") as caught:
                    self.store(database_url=database_url)
                self.assertNotIsInstance(caught.exception, SupabaseWriterBusy)
                self.assertEqual(self.database.lock_attempts, 1)

    def test_broken_connection_is_not_reopened(self):
        store = self.store()
        store.connection.broken = True
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.load()
        self.assertFalse(store.healthy)
        self.assertEqual(len(self.database.connections), 1)

    def test_failed_deletion_is_committed_and_retried_after_restart(self):
        store = self.store()
        store.save({"version": 1, "pages": ["page"]}, {"upload_1": (b"source", b"inference")})
        self.storage.fail_delete = 1
        store.save({"version": 1, "pages": []}, {})
        self.assertEqual(self.database.state["payload"], {"version": 1, "pages": []})
        self.assertEqual(self.database.images, {})
        self.assertEqual(len(self.database.outbox), 2)
        self.assertTrue(store.healthy)
        store.close()
        self.assertEqual(self.store().load(), ({"version": 1, "pages": []}, {}))
        self.assertEqual(self.database.outbox, set())
        self.assertEqual(self.storage.objects, {"unrelated/logo.png": b"another application's image"})

    def test_partial_upload_has_durable_orphan_ledger_and_does_not_commit_snapshot(self):
        store = self.store()
        self.storage.fail_post_number = 2
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.save({"version": 1, "pages": ["page"]}, {"upload_1": (b"source", b"inference")})
        self.assertFalse(store.healthy)
        self.assertIsNone(self.database.state["payload"])
        self.assertEqual(self.database.images, {})
        self.assertEqual(len(self.database.outbox), 2)
        self.assertEqual(len(self.storage.objects), 2)
        store.close()
        self.assertEqual(self.store().load(), (None, {}))
        self.assertEqual(self.database.outbox, set())
        self.assertEqual(len(self.storage.objects), 1)

    def test_failed_snapshot_transaction_keeps_previous_manifest_and_cleans_new_orphans(self):
        store = self.store()
        images = {"upload_old": (b"old-source", b"old-inference")}
        store.save({"version": 1, "revision": 1}, images)
        store.connection.fail_snapshot = True
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.save({"version": 1, "revision": 2}, {"upload_new": (b"new-source", b"new-inference")})
        self.assertEqual(self.database.state["payload"], {"version": 1, "revision": 1})
        self.assertEqual(set(self.database.images), {"upload_old"})
        self.assertEqual(len(self.database.outbox), 2)
        store.close()
        self.assertEqual(self.store().load(), ({"version": 1, "revision": 1}, images))
        self.assertEqual(len(self.storage.objects), 3)

    def test_cleanup_never_deletes_a_referenced_or_unrelated_object(self):
        store = self.store()
        images = {"upload_1": (b"source", b"inference")}
        store.save({"version": 1, "pages": ["page"]}, images)
        referenced = self.database.images["upload_1"][0]
        self.database.outbox.add(referenced)
        self.assertEqual(store.load(), ({"version": 1, "pages": ["page"]}, images))
        self.assertIn(referenced, self.storage.objects)
        self.assertIn("unrelated/logo.png", self.storage.objects)
        self.database.outbox.add("unrelated/logo.png")
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.load()
        self.assertIn("unrelated/logo.png", self.storage.objects)

    def test_immutable_id_reuse_and_download_corruption_fail_closed(self):
        store = self.store()
        images = {"upload_1": (b"source", b"inference")}
        store.save({"version": 1, "pages": ["page"]}, images)
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.save({"version": 1, "pages": ["page"]}, {"upload_1": (b"changed-source", b"inference")})
        self.assertEqual(self.storage.posts, 2)
        store.close()
        store = self.store()
        self.storage.objects[self.database.images["upload_1"][0]] = b"corrupted"
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.load()
        self.assertFalse(store.healthy)

    def test_initialization_does_not_expose_connection_or_key_errors(self):
        def fail(_url, **_kwargs):
            raise RuntimeError("postgresql://backend:database-password@host and sb_secret_private")

        with self.assertRaises(RuntimeError) as caught:
            SupabaseStateStore("postgresql://backend:password@db.example.com/postgres", "https://project.supabase.co",
                               "sb_secret_private", connection_factory=fail)
        self.assertNotIn("database-password", str(caught.exception))
        self.assertNotIn("sb_secret_private", str(caught.exception))
        self.assertTrue(caught.exception.__suppress_context__)

    def test_expired_missing_images_are_skipped_and_retired_by_committed_cleanup(self):
        store = self.store()
        payload = {"version": 1, "sessions": {
            "live-owner": {"expires": self.wall + 60, "pages": {
                "live": {"upload_id": "upload_live", "expires": self.wall + 30},
                "expired": {"upload_id": "upload_expired", "expires": self.wall - 1}}},
            "expired-owner": {"expires": self.wall - 1, "pages": {
                "page": {"upload_id": "upload_session_expired", "expires": self.wall + 30}}}}}
        images = {key: (key.encode(), b"inference") for key in
                  ("upload_live", "upload_expired", "upload_session_expired")}
        store.save(payload, images)
        for upload_id in ("upload_expired", "upload_session_expired"):
            for key in self.database.images[upload_id][:2]:
                self.storage.objects.pop(key)
        store.close()
        restored = self.store()
        before = len(self.storage.requests)
        self.assertEqual(restored.load(), (payload, {"upload_live": images["upload_live"]}))
        self.assertEqual(len([request for request in self.storage.requests[before:] if request.method == "GET"]), 2)
        self.assertTrue(restored.healthy)
        # Service pruning feeds an authoritative live snapshot back before ready.
        pruned = deepcopy(payload)
        del pruned["sessions"]["expired-owner"]
        del pruned["sessions"]["live-owner"]["pages"]["expired"]
        self.storage.fail_delete = 1
        restored.save(pruned, {"upload_live": images["upload_live"]})
        self.assertEqual(set(self.database.images), {"upload_live"})
        self.assertEqual(len(self.database.outbox), 4)
        restored.close()
        self.assertEqual(self.store().load(), (pruned, {"upload_live": images["upload_live"]}))
        self.assertEqual(self.database.outbox, set())
        self.assertIn("unrelated/logo.png", self.storage.objects)

    def test_missing_live_image_still_fails_closed(self):
        store = self.store()
        payload = {"version": 1, "sessions": {"owner": {"expires": self.wall + 60,
            "pages": {"page": {"upload_id": "upload_live", "expires": self.wall + 30}}}}}
        store.save(payload, {"upload_live": (b"source", b"inference")})
        self.storage.objects.pop(self.database.images["upload_live"][1])
        with self.assertRaisesRegex(RuntimeError, "unavailable"):
            store.load()
        self.assertFalse(store.healthy)


if __name__ == "__main__":
    unittest.main()
