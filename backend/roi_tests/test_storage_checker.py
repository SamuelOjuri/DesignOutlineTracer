"""The operational checker must keep credentials private and writes explicit."""
from contextlib import redirect_stdout
from io import StringIO
import os
import unittest
from unittest.mock import MagicMock, patch

import httpx
from psycopg.errors import InsufficientPrivilege, InvalidPassword, UndefinedColumn

from backend.scripts.check_supabase_storage import main


ENVIRONMENT = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SECRET_KEY": "sb_secret_synthetic_private_key",
    "DATABASE_URL": "postgresql://postgres.example:synthetic_password@pooler.example.com:5432/postgres",
    "ROI_STORAGE_BUCKET": "roi-pages",
}


class StorageCheckerTests(unittest.TestCase):
    @staticmethod
    def healthy_database():
        database = MagicMock()
        database.__enter__.return_value = database
        database.execute.return_value.fetchone.return_value = ("roi.state", "roi.images", "roi.delete_outbox")
        return database

    @staticmethod
    def healthy_storage():
        http = MagicMock()
        http.__enter__.return_value = http
        http.get.return_value = httpx.Response(200, json={"public": False})
        return http

    def run_check(self, *args, environment=None):
        output = StringIO()
        with patch.dict(os.environ, ENVIRONMENT | (environment or {}), clear=True), redirect_stdout(output):
            code = main(list(args))
        self.assertNotIn(ENVIRONMENT["SUPABASE_SECRET_KEY"], output.getvalue())
        self.assertNotIn("synthetic_password", output.getvalue())
        self.assertNotIn(ENVIRONMENT["DATABASE_URL"], output.getvalue())
        self.assertNotIn("sensitive-response-body", output.getvalue())
        return code, output.getvalue()

    def test_local_validation_never_connects_and_errors_never_print_secrets(self):
        with patch("httpx.Client") as http, patch("psycopg.connect") as database:
            self.assertEqual(self.run_check("--local-only")[0], 0)
            code, output = self.run_check("--local-only", environment={"ROI_STORAGE_BUCKET": "`roi-pages`"})
            self.assertEqual(code, 1)
            self.assertIn("invalid_storage_bucket", output)
            http.assert_not_called()
            database.assert_not_called()

    def test_default_remote_check_does_not_execute_migration_or_mutate_state(self):
        database = MagicMock()
        database.__enter__.return_value = database
        database.execute.return_value.fetchone.return_value = ("roi.state", "roi.images", "roi.delete_outbox")
        http = MagicMock()
        http.__enter__.return_value = http
        http.get.return_value.is_success = True
        http.get.return_value.json.return_value = {"public": False}
        with patch("httpx.Client", return_value=http), patch("psycopg.connect", return_value=database):
            code, output = self.run_check()
        self.assertEqual(code, 0, output)
        queries = [call.args[0].strip().upper() for call in database.execute.call_args_list]
        self.assertTrue(all(query.startswith(("SET ", "SELECT ")) for query in queries))
        headers = http.get.call_args.kwargs["headers"]
        self.assertEqual(headers["apikey"], ENVIRONMENT["SUPABASE_SECRET_KEY"])
        self.assertNotIn("Authorization", headers)

    def test_explicit_migration_refuses_a_schema_containing_unrelated_tables(self):
        database = MagicMock()
        database.__enter__.return_value = database
        database.execute.return_value.fetchall.return_value = [("another_application",)]
        http = MagicMock()
        http.__enter__.return_value = http
        http.get.return_value.is_success = True
        http.get.return_value.json.return_value = {"public": False}
        with patch("httpx.Client", return_value=http), patch("psycopg.connect", return_value=database):
            code, output = self.run_check("--apply-migration")
        self.assertEqual(code, 1)
        self.assertIn("contains other tables", output)
        self.assertFalse(any("CREATE SCHEMA" in call.args[0] for call in database.execute.call_args_list))

    def test_bucket_http_failure_still_checks_database_without_disclosing_response(self):
        database = self.healthy_database()
        http = self.healthy_storage()
        http.get.return_value = httpx.Response(403, text="sensitive-response-body " + ENVIRONMENT["SUPABASE_SECRET_KEY"],
            request=httpx.Request("GET", ENVIRONMENT["SUPABASE_URL"] + "/storage/v1/bucket/private-name"))
        with patch("httpx.Client", return_value=http), patch("psycopg.connect", return_value=database) as connect:
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("stage=storage_bucket_request", output)
        self.assertIn("exception_type=HTTPStatusError", output)
        self.assertIn("http_status=403", output)
        self.assertIn("All required private ROI tables are present", output)
        self.assertNotIn("private-name", output)
        connect.assert_called_once()
        self.assertTrue(all(call.args[0].strip().upper().startswith(("SET ", "SELECT "))
                            for call in database.execute.call_args_list))

    def test_bucket_timeout_reports_safe_exception_type_and_still_checks_database(self):
        http = self.healthy_storage()
        http.get.side_effect = httpx.ConnectTimeout(ENVIRONMENT["DATABASE_URL"] + " " + ENVIRONMENT["SUPABASE_SECRET_KEY"])
        with patch("httpx.Client", return_value=http), patch("psycopg.connect", return_value=self.healthy_database()):
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("stage=storage_bucket_request exception_type=ConnectTimeout", output)
        self.assertIn("http_status=none sqlstate=none", output)
        self.assertIn("Postgres connection is reachable with SSL", output)

    def test_database_connection_failure_includes_sqlstate_without_exception_text(self):
        error = InvalidPassword(ENVIRONMENT["DATABASE_URL"] + " " + ENVIRONMENT["SUPABASE_SECRET_KEY"])
        with patch("httpx.Client", return_value=self.healthy_storage()), patch("psycopg.connect", side_effect=error):
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("Private Storage bucket is reachable", output)
        self.assertIn("stage=postgres_connect exception_type=InvalidPassword", output)
        self.assertIn("sqlstate=28P01", output)
        self.assertNotIn("All required private ROI tables are present", output)

    def test_schema_column_failure_is_distinct_from_connection_failure(self):
        database = self.healthy_database()
        rows = database.execute.return_value

        def execute(query, *_args, **_kwargs):
            if query.startswith("SELECT bucket, prefix, payload"):
                raise UndefinedColumn("sensitive-response-body " + ENVIRONMENT["DATABASE_URL"])
            return rows

        database.execute.side_effect = execute
        with patch("httpx.Client", return_value=self.healthy_storage()), patch("psycopg.connect", return_value=database):
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("Postgres connection is reachable with SSL", output)
        self.assertIn("stage=postgres_schema_check exception_type=UndefinedColumn", output)
        self.assertIn("sqlstate=42703", output)
        self.assertNotIn("All required private ROI tables are present", output)

    def test_session_setup_failure_is_distinct_from_schema_failure(self):
        database = self.healthy_database()
        database.execute.side_effect = InsufficientPrivilege(ENVIRONMENT["DATABASE_URL"])
        with patch("httpx.Client", return_value=self.healthy_storage()), patch("psycopg.connect", return_value=database):
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("stage=postgres_session_setup exception_type=InsufficientPrivilege", output)
        self.assertIn("sqlstate=42501", output)

    def test_failed_bucket_prevents_requested_migration_but_not_read_only_database_check(self):
        database = self.healthy_database()
        http = self.healthy_storage()
        http.get.return_value = httpx.Response(503, request=httpx.Request("GET", ENVIRONMENT["SUPABASE_URL"]))
        with patch("httpx.Client", return_value=http), patch("psycopg.connect", return_value=database):
            code, output = self.run_check("--apply-migration")
        self.assertEqual(code, 1)
        self.assertIn("Migration skipped", output)
        self.assertIn("All required private ROI tables are present", output)
        database.transaction.assert_not_called()
        self.assertTrue(all(call.args[0].strip().upper().startswith(("SET ", "SELECT "))
                            for call in database.execute.call_args_list))

    def test_independent_bucket_and_database_failures_are_both_reported(self):
        http = self.healthy_storage()
        http.get.side_effect = httpx.ReadTimeout(ENVIRONMENT["SUPABASE_SECRET_KEY"])
        with patch("httpx.Client", return_value=http), patch("psycopg.connect", side_effect=InvalidPassword("synthetic_password")):
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("stage=storage_bucket_request exception_type=ReadTimeout", output)
        self.assertIn("stage=postgres_connect exception_type=InvalidPassword", output)

    def test_public_bucket_failure_still_checks_database(self):
        http = self.healthy_storage()
        http.get.return_value = httpx.Response(200, json={"public": True, "name": "sensitive-response-body"})
        with patch("httpx.Client", return_value=http), patch("psycopg.connect", return_value=self.healthy_database()):
            code, output = self.run_check()
        self.assertEqual(code, 1)
        self.assertIn("stage=storage_bucket_validate exception_type=ValueError", output)
        self.assertIn("http_status=200", output)
        self.assertIn("Postgres connection is reachable with SSL", output)

    def test_migration_failure_has_its_own_stage_and_sqlstate(self):
        database = self.healthy_database()
        rows = database.execute.return_value
        rows.fetchall.return_value = []

        def execute(query, *_args, **_kwargs):
            if query == "CREATE SCHEMA roi;":
                raise InsufficientPrivilege("sensitive-response-body " + ENVIRONMENT["DATABASE_URL"])
            return rows

        database.execute.side_effect = execute
        with patch("httpx.Client", return_value=self.healthy_storage()), patch("psycopg.connect", return_value=database), \
                patch("backend.scripts.check_supabase_storage.MIGRATION") as migration:
            migration.is_file.return_value = True
            migration.read_text.return_value = "CREATE SCHEMA roi;"
            code, output = self.run_check("--apply-migration")
        self.assertEqual(code, 1)
        self.assertIn("stage=postgres_migration_apply exception_type=InsufficientPrivilege", output)
        self.assertIn("sqlstate=42501", output)
