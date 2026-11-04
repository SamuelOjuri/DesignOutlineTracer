"""Single-process durable ROI state on an attached persistent disk.

Only JSON and image bytes are stored. An OS lock prevents accidentally starting
multiple workers against a store whose live operations are owned by one process.
"""
import json
import os
from pathlib import Path
import sqlite3


class StateStore:
    def __init__(self, path: str):
        target = Path(path).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        self.lock = open(str(target) + ".lock", "a+b")
        self.connection = None
        try:
            if os.name == "nt":
                import msvcrt
                self.lock.seek(0)
                if not self.lock.read(1):
                    self.lock.write(b"0")
                    self.lock.flush()
                self.lock.seek(0)
                msvcrt.locking(self.lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock.close()
            raise RuntimeError("ROI state is already open; run exactly one service instance and one worker") from None
        try:
            self.connection = sqlite3.connect(target)
            self.connection.execute("PRAGMA journal_mode=WAL")
            self.connection.execute("PRAGMA synchronous=FULL")
            self.connection.execute("PRAGMA secure_delete=ON")
            self.connection.execute("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)")
            self.connection.execute("CREATE TABLE IF NOT EXISTS images (upload_id TEXT PRIMARY KEY, original BLOB NOT NULL, png BLOB NOT NULL)")
            self.connection.commit()
        except Exception:
            self.close()
            raise

    def load(self):
        row = self.connection.execute("SELECT payload FROM state WHERE id=1").fetchone()
        payload = json.loads(row[0]) if row else None
        images = {row[0]: (row[1], row[2]) for row in self.connection.execute("SELECT upload_id, original, png FROM images")}
        return payload, images

    def save(self, payload: dict, images: dict[str, tuple[bytes, bytes]]) -> None:
        encoded = json.dumps(payload, separators=(",", ":"), allow_nan=False)
        with self.connection:
            existing = {row[0] for row in self.connection.execute("SELECT upload_id FROM images")}
            self.connection.executemany("INSERT INTO images(upload_id, original, png) VALUES (?, ?, ?)",
                                        [(key, *value) for key, value in images.items() if key not in existing])
            self.connection.executemany("DELETE FROM images WHERE upload_id=?", [(key,) for key in existing - images.keys()])
            self.connection.execute("INSERT INTO state(id, payload) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload", (encoded,))
        # Ensure retired page bytes also leave the WAL after deletion/expiry.
        if existing - images.keys():
            self.connection.execute("PRAGMA wal_checkpoint(TRUNCATE)")

    def close(self):
        if self.connection is not None:
            self.connection.close()
            self.connection = None
        if not self.lock.closed:
            # Closing the handle releases either OS lock, including on crashes.
            self.lock.close()
