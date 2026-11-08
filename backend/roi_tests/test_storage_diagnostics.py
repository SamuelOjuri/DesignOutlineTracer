"""Diagnostic metadata must not serialize private exception or request content."""
import unittest

import httpx

from backend.app.storage_diagnostics import StorageOperationError, storage_failure_details, storage_operation


class StorageDiagnosticTests(unittest.TestCase):
    def test_untrusted_metadata_cannot_inject_log_lines_or_extra_fields(self):
        error = type("Invalid\nType", (RuntimeError,), {})("sb_secret_private")
        error.sqlstate = "08006\nsecret=private"
        details = storage_failure_details("connect\nsecret=private", error, http_status=True)
        self.assertEqual(details, "stage=unknown exception_type=Exception http_status=none sqlstate=none")
        for status in ("503\nsecret=private", -1, 600):
            with self.subTest(status=status):
                self.assertIn("http_status=none", storage_failure_details("connect", error, http_status=status))

    def test_nested_operations_keep_the_first_stage_and_http_status(self):
        request = httpx.Request("GET", "https://private.example/private-object", headers={"apikey": "sb_secret_private"})
        response = httpx.Response(503, request=request, text="private response")
        with self.assertRaises(StorageOperationError) as caught:
            with storage_operation("outer"):
                with storage_operation("storage_object_download"):
                    response.raise_for_status()
        details = storage_failure_details("fallback", caught.exception)
        self.assertEqual(details, "stage=storage_object_download exception_type=HTTPStatusError http_status=503 sqlstate=none")
        self.assertEqual(str(caught.exception), "ROI storage operation failed")
        self.assertTrue(caught.exception.__suppress_context__)


if __name__ == "__main__":
    unittest.main()
