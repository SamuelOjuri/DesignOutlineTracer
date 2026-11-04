"""The operational checker must keep credentials private and writes explicit."""
from contextlib import redirect_stdout
from io import StringIO
import os
import unittest
from unittest.mock import MagicMock, patch

from backend.scripts.check_supabase_storage import main


ENVIRONMENT = {
    "SUPABASE_URL": "https://example.supabase.co",
    "SUPABASE_SECRET_KEY": "sb_secret_synthetic_private_key",
    "DATABASE_URL": "postgresql://postgres.example:synthetic_password@pooler.example.com:5432/postgres",
    "ROI_STORAGE_BUCKET": "roi-pages",
}


class StorageCheckerTests(unittest.TestCase):
    def run_check(self, *args, environment=None):
        output = StringIO()
        with patch.dict(os.environ, ENVIRONMENT | (environment or {}), clear=True), redirect_stdout(output):
            code = main(list(args))
        self.assertNotIn(ENVIRONMENT["SUPABASE_SECRET_KEY"], output.getvalue())
        self.assertNotIn("synthetic_password", output.getvalue())
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
