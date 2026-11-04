import os
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from backend.app.config import Settings


PROJECT_URL = "https://example-project.supabase.co"
DATABASE_URL = "postgresql://postgres.project:synthetic-database-password@aws-0-eu.pooler.supabase.com:5432/postgres?sslmode=require"
SECRET_KEY = "sb_secret_synthetic-storage-credential"


class SupabaseConfigTests(unittest.TestCase):
    def settings(self, **changes):
        return Settings(**(dict(supabase_url=PROJECT_URL, database_url=DATABASE_URL,
                               supabase_secret_key=SECRET_KEY, storage_bucket="roi-pages") | changes))

    def test_auto_selects_supabase_without_a_local_state_path(self):
        settings = self.settings(deployment_mode="public", allowed_origins=("https://app.netlify.app",),
                                 allowed_hosts=("api.onrender.com",))
        self.assertEqual(settings.resolved_storage_backend, "supabase")
        self.assertIsNone(settings.state_path)
        self.assertEqual(Settings().resolved_storage_backend, "memory")
        self.assertEqual(Settings(state_path="state.sqlite3").resolved_storage_backend, "sqlite")
        self.assertEqual(self.settings(storage_backend="sqlite", state_path="state.sqlite3").resolved_storage_backend, "sqlite")

    def test_environment_uses_the_documented_credential_names(self):
        with patch.dict(os.environ, {
            "SUPABASE_URL": PROJECT_URL, "SUPABASE_SECRET_KEY": SECRET_KEY, "DATABASE_URL": DATABASE_URL,
            "ROI_STORAGE_BUCKET": "drawing-pages", "ROI_STORAGE_BACKEND": "supabase",
        }, clear=True):
            settings = Settings.from_env()
        self.assertEqual(settings.resolved_storage_backend, "supabase")
        self.assertEqual(settings.storage_bucket, "drawing-pages")
        self.assertEqual(settings.database_url.get_secret_value(), DATABASE_URL)
        self.assertEqual(settings.supabase_secret_key.get_secret_value(), SECRET_KEY)

    def test_partial_or_missing_selected_configuration_fails_instead_of_falling_back(self):
        for changes in ({"supabase_url": None}, {"database_url": None}, {"supabase_secret_key": None},
                        {"supabase_secret_key": ""}, {"storage_bucket": ""}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.settings(**changes)
        with self.assertRaises(ValidationError):
            Settings(storage_backend="supabase")
        with self.assertRaises(ValidationError):
            Settings(storage_backend="sqlite")

    def test_public_mode_rejects_ephemeral_memory_even_when_credentials_exist(self):
        with self.assertRaises(ValidationError):
            self.settings(storage_backend="memory", deployment_mode="public", allowed_origins=("https://app.netlify.app",),
                          allowed_hosts=("api.onrender.com",))

    def test_rejects_bad_project_urls_and_bucket_paths(self):
        for url in ("http://example.supabase.co", "https://example.supabase.co/", "https://key@example.supabase.co",
                    "https://example.supabase.co/path", "https://example.supabase.co?", "https://example.supabase.co:99999"):
            with self.subTest(url=url), self.assertRaises(ValidationError):
                self.settings(supabase_url=url)
        self.assertEqual(self.settings(storage_bucket="roi.pages").storage_bucket, "roi.pages")
        for bucket in ("../roi-pages", "roi/pages", "`roi-pages`", "ROI storage bucket name"):
            with self.subTest(bucket=bucket), self.assertRaises(ValidationError):
                self.settings(storage_bucket=bucket)

    def test_requires_a_session_preserving_database_connection_and_encryption(self):
        for url in (DATABASE_URL.replace(":5432", ":6543"), DATABASE_URL.replace("postgresql:", "https:"),
                    DATABASE_URL.replace("sslmode=require", "sslmode=disable"), "Postgres connection URI",
                    "postgresql://user@db.example.com/postgres", "postgresql://user:secret@db.example.com/",
                    DATABASE_URL + "#fragment"):
            with self.subTest(url=url), self.assertRaises(ValidationError):
                self.settings(database_url=url)
        self.assertEqual(self.settings(database_url="postgresql://postgres:password@db.example.com/postgres").resolved_storage_backend,
                         "supabase")

    def test_secrets_are_masked_on_success_and_unrelated_validation_failures(self):
        settings = self.settings(api_key="synthetic-gemini-secret")
        for name in ("api_key", "database_url", "supabase_secret_key"):
            self.assertNotIn(name, settings.model_dump())
        for changes in ({"max_attempts": 9}, {"storage_bucket": "../invalid"}, {"storage_backend": "invalid"},
                        {"database_url": "malformed-super-private-password"}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError) as raised:
                self.settings(api_key="synthetic-gemini-secret", **changes)
            rendered = str(raised.exception) + repr(raised.exception) + repr(raised.exception.errors()) + raised.exception.json()
            for secret in (SECRET_KEY, DATABASE_URL, "synthetic-database-password", "synthetic-gemini-secret",
                           "malformed-super-private-password"):
                self.assertNotIn(secret, rendered)
        self.assertNotIn(SECRET_KEY, repr(settings))
        self.assertNotIn("synthetic-database-password", repr(settings))
