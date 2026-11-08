"""Check Supabase configuration without printing credentials or changing ROI state.

The explicit --apply-migration flag applies only the reviewed additive schema SQL.
No bucket objects, application snapshots or provider calls are created by checks.
"""
import argparse
from pathlib import Path
import re
from urllib.parse import parse_qs, quote, urlsplit

import httpx
from dotenv import load_dotenv
from pydantic import ValidationError

from backend.app.config import Settings
from backend.app.storage_diagnostics import storage_failure_details


MIGRATION = Path(__file__).resolve().parents[2] / "supabase/migrations/20261104180000_roi_private_state.sql"


def check_private_bucket(settings: Settings) -> bool:
    stage = "storage_bucket_request"
    http_status = None
    key = settings.supabase_secret_key.get_secret_value()
    headers = {"apikey": key}
    if not key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {key}"
    try:
        with httpx.Client(timeout=15, follow_redirects=False) as client:
            response = client.get(settings.supabase_url + "/storage/v1/bucket/" + quote(settings.storage_bucket, safe=""),
                                  headers=headers)
            http_status = response.status_code
            if not response.is_success:
                response.raise_for_status()
            stage = "storage_bucket_validate"
            bucket = response.json()
            if not isinstance(bucket, dict) or bucket.get("public") is not False:
                raise ValueError("private_bucket_required")
            stage = "storage_client_close"
        print("Private Storage bucket is reachable.")
        return True
    except Exception as error:
        print("Private Storage bucket check failed: " + storage_failure_details(stage, error, http_status=http_status))
        print("Verify the endpoint, credentials, network access and that the configured bucket is private.")
        return False


def check_database(settings: Settings, *, apply_migration: bool, bucket_ok: bool) -> bool:
    stage = "postgres_connect"
    try:
        import psycopg
        uri = settings.database_url.get_secret_value()
        sslmode = parse_qs(urlsplit(uri).query).get("sslmode", ["require"])[0]
        with psycopg.connect(uri, connect_timeout=10, sslmode=sslmode, autocommit=True,
                             prepare_threshold=None) as connection:
            stage = "postgres_session_setup"
            connection.execute("SET statement_timeout = '15s'")
            connection.execute("SET lock_timeout = '5s'")
            print("Postgres connection is reachable with SSL.")
            if apply_migration and not bucket_ok:
                # Keep the existing mutation guard while still checking database health.
                print("Migration skipped because the private Storage bucket check failed.")
            elif apply_migration:
                stage = "postgres_migration_preflight"
                if not MIGRATION.is_file():
                    print("Migration file is missing from the repository checkout.")
                    return False
                existing = {row[0] for row in connection.execute(
                    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'roi'").fetchall()}
                if existing - {"state", "images", "delete_outbox"}:
                    print("Migration stopped: the roi schema contains other tables; review it before applying this migration.")
                    return False
                stage = "postgres_migration_apply"
                with connection.transaction():
                    connection.execute(MIGRATION.read_text(encoding="utf-8"), prepare=False)
                print("Private ROI database migration applied.")
            stage = "postgres_schema_check"
            required = ("roi.state", "roi.images", "roi.delete_outbox")
            present = connection.execute("SELECT to_regclass(%s), to_regclass(%s), to_regclass(%s)", required).fetchone()
            if not present or any(value is None for value in present):
                print("ROI schema is missing. Apply supabase/migrations/20261104180000_roi_private_state.sql before startup.")
                return False
            # Exercise the columns and read permissions used by the application.
            # Table existence alone cannot detect an incomplete migration.
            connection.execute("SELECT bucket, prefix, payload FROM roi.state LIMIT 0").fetchall()
            connection.execute("""SELECT upload_id, source_key, inference_key,
                source_sha256, inference_sha256 FROM roi.images LIMIT 0""").fetchall()
            connection.execute("SELECT object_key, created_at FROM roi.delete_outbox LIMIT 0").fetchall()
            stage = "postgres_connection_close"
        print("All required private ROI tables are present. No application state or model calls were created.")
        return True
    except Exception as error:
        print("Postgres check failed: " + storage_failure_details(stage, error))
        print("Verify the session-pooler/direct connection, database password, migration permissions and SSL.")
        return False


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, help="Explicit local environment file; process values take precedence")
    parser.add_argument("--local-only", action="store_true", help="Validate values without making network requests")
    parser.add_argument("--apply-migration", action="store_true", help="Apply the additive private ROI database schema")
    args = parser.parse_args(argv)
    if args.local_only and args.apply_migration:
        parser.error("--local-only cannot be combined with --apply-migration")
    if args.env_file is not None:
        if not args.env_file.is_file():
            print("Environment file not found.")
            return 1
        load_dotenv(args.env_file, override=False)
    try:
        settings = Settings.from_env()
    except ValidationError as error:
        # Never print the input mapping or a database URI from validation errors.
        for item in error.errors(include_input=False, include_context=True, include_url=False):
            detail = str(item.get("ctx", {}).get("error", item["type"]))
            code = detail if re.fullmatch(r"[a-z0-9_]+", detail) else item["type"]
            print(f"Configuration invalid: {code}.")
        return 1
    if settings.resolved_storage_backend != "supabase":
        print("Supabase is not selected. Supply SUPABASE_URL, SUPABASE_SECRET_KEY, DATABASE_URL and ROI_STORAGE_BUCKET.")
        return 1
    print("Supabase environment configuration is valid; credential values are hidden.")
    if args.local_only:
        return 0

    bucket_ok = check_private_bucket(settings)
    database_ok = check_database(settings, apply_migration=args.apply_migration, bucket_ok=bucket_ok)
    return 0 if bucket_ok and database_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
