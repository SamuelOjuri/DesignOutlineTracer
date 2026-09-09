from copy import deepcopy
from pathlib import Path
import unittest

from pydantic import ValidationError

from backend.roi_reference.evaluation import Manifest, audit_manifest, score_boxes


PENDING = {
    "schema_version": "evaluation-v1", "policy_status": "draft", "original_jpeg_status": "unavailable",
    "cases": [{"id": "pending", "document_id": "doc", "split": "development", "tags": [],
               "input_variant": "pdfjs_page", "image_path": None, "status": "awaiting_source",
               "expected": {"roof_roi": None, "penetration": None, "rainwater_outlet": None}}],
}


class EvaluationTests(unittest.TestCase):
    def test_pending_manifest_cannot_pass_domain_gate(self):
        report = audit_manifest(Manifest.model_validate(PENDING), Path("."))
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["reviewed_cases"], 0)
        self.assertIn("missing_reviewed_coverage:unmarked", report["blockers"])

    def test_cannot_promote_unlabelled_case_or_leak_document_between_splits(self):
        manifest = deepcopy(PENDING)
        manifest["cases"][0]["status"] = "reviewed"
        with self.assertRaises(ValidationError):
            Manifest.model_validate(manifest)
        manifest = deepcopy(PENDING)
        manifest["cases"].append(manifest["cases"][0] | {"id": "other", "split": "held_out"})
        with self.assertRaises(ValidationError):
            Manifest.model_validate(manifest)

    def test_duplicates_false_positives_and_misses_are_counted(self):
        first = {"box_2d": [10, 20, 100, 200]}
        second = {"box_2d": [300, 400, 500, 600]}
        score = score_boxes([first, second], [first, first], 0.5)
        self.assertEqual(score["true_positive"], 1)
        self.assertEqual(score["false_positive"], 1)
        self.assertEqual(score["false_negative"], 1)
        self.assertEqual(score["matched_ious"], [1.0])
        self.assertEqual(score_boxes([], [first], 0.5)["false_positive"], 1)

    def test_association_errors_are_separate_from_object_detection(self):
        target = {"box_2d": [10, 20, 100, 200], "roi_id": "roi-1", "subtype": "vent"}
        result = score_boxes([target], [target | {"roi_id": "roi-2"}], 0.5)
        self.assertEqual(result["true_positive"], 1)
        self.assertEqual(result["correct_parent_matches"], 0)
        self.assertEqual(result["matched_position_errors_0_1000"], [0])
        self.assertEqual(score_boxes([target], [target | {"subtype": "rooflight"}], 0.5)["false_negative"], 1)