import os
import unittest
from unittest.mock import patch

from pydantic import ValidationError

from backend.app.config import Settings


class ProductionConfigTests(unittest.TestCase):
    def public_settings(self, **changes):
        values = dict(deployment_mode="public", allowed_origins=("https://roof-editor.netlify.app",),
                      allowed_hosts=("roof-api.onrender.com",), state_path="/var/data/roi.sqlite3")
        return Settings(**(values | changes))

    def test_public_mode_accepts_exact_https_origins_and_custom_api_hosts(self):
        settings = self.public_settings(allowed_origins=("https://roof-editor.netlify.app", "https://app.example.com:8443"),
                                        allowed_hosts=("roof-api.onrender.com", "api.example.com", "127.0.0.1"))
        self.assertEqual(settings.deployment_mode, "public")
        self.assertEqual(settings.state_path, "/var/data/roi.sqlite3")
        self.assertEqual(settings.call_budget_window_seconds, 86400)

    def test_public_mode_rejects_invalid_origins_instead_of_broadening_cors(self):
        origins = ("", "*", "https://*.netlify.app", "http://app.example.com", "http://localhost:8081",
                   "https://app.example.com/", "https://app.example.com/path", "https://user@app.example.com",
                   "https://app.example.com?", "https://app.example.com#", "https://app.example.com:bad",
                   "https://app.example.com:65536", "https://app.example.com:0", "https://app.example.com:",
                   "https://app.example.com\n", "https://app.example.com\\evil", "https://.example.com")
        for origin in origins:
            with self.subTest(origin=origin), self.assertRaises(ValidationError):
                self.public_settings(allowed_origins=(origin,))
        with self.assertRaises(ValidationError):
            self.public_settings(allowed_origins=())

    def test_public_mode_requires_persistent_storage_and_an_explicit_public_host(self):
        for changes in ({"state_path": None}, {"state_path": ""}, {"state_path": " "}, {"state_path": ":memory:"},
                        {"allowed_hosts": ()}, {"allowed_hosts": ("localhost",)}, {"allowed_hosts": ("*",)},
                        {"allowed_hosts": ("*.onrender.com",)}, {"allowed_hosts": ("api.example.com:443",)},
                        {"allowed_hosts": ("https://api.example.com",)}, {"allowed_hosts": ("api.example.com/path",)}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                self.public_settings(**changes)

    def test_render_environment_derives_own_hostname_and_parses_allowlists(self):
        with patch.dict(os.environ, {
            "ROI_DEPLOYMENT_MODE": "public", "ROI_ALLOWED_ORIGINS": "https://roof-editor.netlify.app, https://app.example.com",
            "ROI_STATE_PATH": "/var/data/roi.sqlite3", "RENDER_EXTERNAL_HOSTNAME": "roof-api.onrender.com",
            "ROI_CALL_BUDGET_WINDOW_SECONDS": "3600",
        }, clear=True):
            settings = Settings.from_env()
            self.assertIn("roof-api.onrender.com", settings.allowed_hosts)
            self.assertEqual(settings.allowed_origins, ("https://roof-editor.netlify.app", "https://app.example.com"))
            self.assertEqual(settings.call_budget_window_seconds, 3600)
            with patch.dict(os.environ, {"ROI_ALLOWED_HOSTS": "api.example.com, roof-api.onrender.com"}):
                self.assertEqual(Settings.from_env().allowed_hosts, ("api.example.com", "roof-api.onrender.com"))

    def test_local_defaults_remain_local_and_budget_window_is_bounded(self):
        self.assertEqual(Settings().deployment_mode, "localhost_only")
        self.assertIsNone(Settings().state_path)
        for changes in ({"allowed_origins": ("https://app.example.com",)},
                        {"allowed_hosts": ("api.example.com",)}, {"call_budget_window_seconds": 0},
                        {"call_budget_window_seconds": float("inf")}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                Settings(**changes)
