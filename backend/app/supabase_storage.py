"""Private Supabase storage for the single-writer ROI service.

The PostgreSQL connection owns a session advisory lock for its entire lifetime.
It is never reconnected: losing that session requires restarting from fresh state.
Storage deletions and pre-upload cleanup are recorded durably in an outbox.
"""
from hashlib import sha256
import json
import re
import threading
import time
from urllib.parse import parse_qs, quote, unquote, urlsplit
from uuid import uuid4

import httpx


PREFIX = "roi-state-v1"
LOCK_ID = 0x524F495354415445
LOCK_HIGH, LOCK_LOW = LOCK_ID >> 32, LOCK_ID & 0xFFFFFFFF
OWNER_QUERY = """SELECT pg_backend_pid(), EXISTS (
    SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
    AND classid = %s::oid AND objid = %s::oid AND objsubid = 1 AND granted
)"""


class SupabaseWriterBusy(RuntimeError):
    """Valid configuration can activate after the existing writer shuts down."""


class SupabaseStateStore:
    deferred = True

    def __init__(self, database_url: str, supabase_url: str, secret_key: str, bucket: str = "roi-pages", *,
                 connection_factory=None, http_client=None, wall_clock=time.time):
        self.connection = None
        self.client = http_client
        self.healthy = False
        self._mutex = threading.RLock()
        self._backend_pid = None
        self.wall_clock = wall_clock
        self.bucket = bucket
        self.base_url = supabase_url.rstrip("/") + "/storage/v1"
        self.headers = {"apikey": secret_key}
        # New secret keys aren't JWTs. Legacy service_role JWTs still require Bearer.
        if not secret_key.startswith("sb_secret_"):
            self.headers["Authorization"] = f"Bearer {secret_key}"
        try:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,99}", bucket):
                raise ValueError("invalid_bucket")
            self._check_project_binding(database_url, supabase_url)
            if connection_factory is None:
                import psycopg
                connection_factory = psycopg.connect
            sslmode = parse_qs(urlsplit(database_url).query).get("sslmode", ["require"])[0]
            self.connection = connection_factory(database_url, autocommit=True, prepare_threshold=None,
                                                 connect_timeout=10, sslmode=sslmode)
            self.connection.execute("SET statement_timeout = '15s'")
            self.connection.execute("SET lock_timeout = '5s'")
            self.client = self.client or httpx.Client(timeout=30, follow_redirects=False)
            self._preflight()
            row = self.connection.execute("SELECT pg_backend_pid(), pg_try_advisory_lock(%s)", (LOCK_ID,)).fetchone()
            if row is None:
                raise RuntimeError("writer_lock_check_failed")
            if not row[1]:
                raise SupabaseWriterBusy("ROI Supabase single-writer state is busy; waiting for the active instance to shut down")
            self._backend_pid = row[0]
            self.healthy = True
            self._check_owner()
            # Bind orphan cleanup to the same bucket even before the first snapshot.
            with self.connection.transaction():
                self.connection.execute("""INSERT INTO roi.state(id, bucket, prefix, payload)
                    VALUES (1, %s, %s, NULL) ON CONFLICT (id) DO NOTHING""", (bucket, PREFIX))
                row = self.connection.execute("SELECT bucket, prefix FROM roi.state WHERE id = 1").fetchone()
                if row != (bucket, PREFIX):
                    raise RuntimeError("storage_namespace_mismatch")
        except SupabaseWriterBusy:
            self.close()
            raise
        except Exception:
            self.close()
            raise RuntimeError("ROI Supabase storage initialization failed; check credentials, private bucket, migration and single-writer configuration") from None

    @staticmethod
    def _check_project_binding(database_url, supabase_url):
        project = re.fullmatch(r"([a-z0-9]+)\.supabase\.co", urlsplit(supabase_url).hostname or "")
        database = urlsplit(database_url)
        direct = re.fullmatch(r"db\.([a-z0-9]+)\.supabase\.co", database.hostname or "")
        database_project = direct[1] if direct else None
        if database_project is None and (database.hostname or "").endswith(".pooler.supabase.com"):
            username = unquote(database.username or "")
            if "." in username:
                database_project = username.rsplit(".", 1)[1]
        if project and database_project and project[1] != database_project:
            raise ValueError("supabase_project_mismatch")

    def _preflight(self):
        # These checks are intentionally read-only and precede the writer-lock
        # attempt. Bad candidates must not pass Render's standby liveness gate.
        bucket_info = self._request("GET", f"/bucket/{quote(self.bucket, safe='')}").json()
        if not isinstance(bucket_info, dict) or bucket_info.get("public") is not False:
            raise RuntimeError("private_bucket_required")
        row = self.connection.execute("SELECT bucket, prefix, payload FROM roi.state WHERE id = 1").fetchone()
        if row is not None:
            if row[:2] != (self.bucket, PREFIX):
                raise RuntimeError("storage_namespace_mismatch")
            payload = json.loads(row[2]) if isinstance(row[2], str) else row[2]
            if payload is not None and (not isinstance(payload, dict) or type(payload.get("version")) is not int
                                        or payload["version"] != 1):
                raise RuntimeError("unsupported_state_version")
        self.connection.execute("""SELECT upload_id, source_key, inference_key,
            source_sha256, inference_sha256 FROM roi.images LIMIT 0""").fetchall()
        self.connection.execute("SELECT object_key, created_at FROM roi.delete_outbox LIMIT 0").fetchall()

    def _fail(self):
        self.healthy = False
        raise RuntimeError("ROI Supabase storage is unavailable; restart the service after restoring connectivity") from None

    def _check_owner(self):
        if not self.healthy or self.connection is None or self.connection.closed or self.connection.broken:
            self._fail()
        try:
            row = self.connection.execute(OWNER_QUERY, (LOCK_HIGH, LOCK_LOW)).fetchone()
            if row is None or row[0] != self._backend_pid or not row[1]:
                self._fail()
        except Exception:
            self._fail()

    def _request(self, method, path, **kwargs):
        headers = {**self.headers, **kwargs.pop("headers", {})}
        response = self.client.request(method, self.base_url + path, headers=headers, **kwargs)
        if not response.is_success:
            raise RuntimeError("storage_request_failed")
        return response

    def _object_path(self, key):
        return f"/object/{quote(self.bucket, safe='')}/{quote(key, safe='/')}"

    def _manifest(self):
        return {row[0]: row[1:] for row in self.connection.execute("""SELECT upload_id, source_key, inference_key,
            source_sha256, inference_sha256 FROM roi.images""").fetchall()}

    @staticmethod
    def _owned_key(key):
        return isinstance(key, str) and re.fullmatch(
            rf"{PREFIX}/[A-Za-z0-9_-]{{1,200}}/[a-f0-9]{{32}}/(?:source|inference)\.png", key) is not None

    def _drain_outbox(self):
        self._check_owner()
        rows = self.connection.execute("""SELECT pending.object_key FROM roi.delete_outbox AS pending
            WHERE NOT EXISTS (SELECT 1 FROM roi.images AS image
                WHERE image.source_key = pending.object_key OR image.inference_key = pending.object_key)
            ORDER BY pending.object_key LIMIT 1000""").fetchall()
        keys = [row[0] for row in rows]
        if not keys:
            return
        if any(not self._owned_key(key) for key in keys):
            self._fail()
        try:
            # The Storage API removes object bytes; deleting its SQL rows would orphan them.
            self._request("DELETE", f"/object/{quote(self.bucket, safe='')}", json={"prefixes": keys})
        except Exception:
            # The committed outbox is retried by later saves and on process restart.
            return
        self._check_owner()
        with self.connection.transaction():
            self.connection.execute("DELETE FROM roi.delete_outbox WHERE object_key = ANY(%s)", (keys,))

    def load(self):
        with self._mutex:
            try:
                self._check_owner()
                self._drain_outbox()
                row = self.connection.execute("SELECT payload FROM roi.state WHERE id = 1").fetchone()
                payload = row[0] if row else None
                if isinstance(payload, str):
                    payload = json.loads(payload)
                live_uploads = None
                if isinstance(payload, dict) and "sessions" in payload:
                    now = self.wall_clock()
                    live_uploads = {
                        page["upload_id"]
                        for session in payload["sessions"].values() if session["expires"] > now
                        for page in session["pages"].values() if page["expires"] > now
                    }
                images = {}
                for upload_id, (source_key, inference_key, source_hash, inference_hash) in self._manifest().items():
                    if not self._owned_key(source_key) or not self._owned_key(inference_key):
                        self._fail()
                    # Expired rendered pages need no download. Service restoration
                    # prunes their metadata, then commits manifest/outbox cleanup.
                    if live_uploads is not None and upload_id not in live_uploads:
                        continue
                    source = self._request("GET", "/object/authenticated" + self._object_path(source_key)[len("/object"):]).content
                    inference = self._request("GET", "/object/authenticated" + self._object_path(inference_key)[len("/object"):]).content
                    if sha256(source).hexdigest() != source_hash or sha256(inference).hexdigest() != inference_hash:
                        self._fail()
                    images[upload_id] = (source, inference)
                self._check_owner()
                return payload, images
            except Exception:
                self._fail()

    def save(self, payload: dict, images: dict[str, tuple[bytes, bytes]]) -> None:
        with self._mutex:
            try:
                encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False)
                self._check_owner()
                manifest = self._manifest()
                additions = {}
                for upload_id, (source, inference) in images.items():
                    if not re.fullmatch(r"[A-Za-z0-9_-]{1,200}", upload_id):
                        self._fail()
                    hashes = (sha256(source).hexdigest(), sha256(inference).hexdigest())
                    if upload_id in manifest:
                        if manifest[upload_id][2:] != hashes:
                            self._fail()  # An immutable upload ID must never name different bytes.
                        continue
                    directory = f"{PREFIX}/{upload_id}/{uuid4().hex}"
                    additions[upload_id] = (f"{directory}/source.png", f"{directory}/inference.png", *hashes)
                new_keys = [key for value in additions.values() for key in value[:2]]
                if new_keys:
                    # Commit a cleanup ledger BEFORE remote uploads so even a process crash
                    # between upload and manifest commit leaves recoverable orphan keys.
                    with self.connection.transaction():
                        for key in new_keys:
                            self.connection.execute("INSERT INTO roi.delete_outbox(object_key) VALUES (%s) ON CONFLICT DO NOTHING", (key,))
                    for upload_id, value in additions.items():
                        for index, key in enumerate(value[:2]):
                            content = images[upload_id][index]
                            content_type = "image/jpeg" if content.startswith(b"\xff\xd8\xff") else "image/png"
                            self._request("POST", self._object_path(key), content=content,
                                          headers={"Content-Type": content_type, "x-upsert": "false"})
                self._check_owner()
                with self.connection.transaction():
                    for upload_id, value in additions.items():
                        self.connection.execute("""INSERT INTO roi.images(upload_id, source_key, inference_key,
                            source_sha256, inference_sha256) VALUES (%s, %s, %s, %s, %s)""", (upload_id, *value))
                    if new_keys:
                        self.connection.execute("DELETE FROM roi.delete_outbox WHERE object_key = ANY(%s)", (new_keys,))
                    for upload_id in manifest.keys() - images.keys():
                        for key in manifest[upload_id][:2]:
                            self.connection.execute("INSERT INTO roi.delete_outbox(object_key) VALUES (%s) ON CONFLICT DO NOTHING", (key,))
                        self.connection.execute("DELETE FROM roi.images WHERE upload_id = %s", (upload_id,))
                    self.connection.execute("UPDATE roi.state SET payload = %s::jsonb, updated_at = now() WHERE id = 1", (encoded,))
                # The snapshot and manifest are durable before successful return.
                self._drain_outbox()
            except Exception:
                self._fail()

    def close(self):
        with self._mutex:
            self.healthy = False
            if self.client is not None:
                try:
                    self.client.close()
                except Exception:
                    pass
                self.client = None
            if self.connection is not None:
                try:
                    self.connection.close()  # Releases the session advisory lock.
                except Exception:
                    pass
                self.connection = None
