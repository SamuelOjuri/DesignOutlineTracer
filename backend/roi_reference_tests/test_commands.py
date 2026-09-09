from copy import deepcopy
from contextlib import redirect_stdout
from hashlib import sha256
from io import StringIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from backend.roi_reference.__main__ import EVALUATION, main
from backend.roi_reference.contracts import ReferenceError
from backend.roi_reference.evaluation import REQUIRED_TAGS, evaluate
from backend.roi_reference.runner import write_json


class CommandTests(unittest.TestCase):
    def test_checked_in_contract_fixtures_and_honest_audit(self):
        with patch("backend.roi_reference.provider.create_client") as client:
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["fixtures"]), 0)
            self.assertEqual(len(json.loads(output.getvalue())["checked"]), 9)
            output = StringIO()
            with redirect_stdout(output):
                self.assertEqual(main(["audit"]), 2)
            self.assertEqual(json.loads(output.getvalue())["reviewed_cases"], 0)
            client.assert_not_called()
        self.assertTrue((EVALUATION / "manifest.json").is_file())

    def test_end_to_end_scoring_and_missing_partial_duplicate_runs(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            manifest = {"schema_version": "evaluation-v1", "policy_status": "approved",
                        "policy_review": {"reviewer": "synthetic-test-reviewer", "reviewed_on": "2026-09-09",
                                          "policy_version": "scope-policy-draft-v1"},
                        "original_jpeg_status": "unavailable", "cases": []}
            for split in ("development", "held_out"):
                for category in ("positive", "child-negative", "no-roof"):
                    case_id = f"{split}-{category}"
                    image = root / f"{case_id}.png"
                    from PIL import Image

                    Image.new("RGB", (10 + len(manifest["cases"]), 10), "white").save(image)
                    digest = sha256(image.read_bytes()).hexdigest()
                    roof = {"id": "roof", "label": "Synthetic roof", "box_2d": [100, 100, 800, 800]}
                    child = {"id": "vent", "label": "Synthetic vent", "box_2d": [200, 200, 210, 210],
                             "roi_id": "roof", "subtype": "vent"}
                    outlet = child | {"id": "outlet", "label": "Synthetic outlet", "subtype": "internal_outlet"}
                    expected = {"roof_roi": [] if category == "no-roof" else [roof],
                                "penetration": [child] if category == "positive" else [],
                                "rainwater_outlet": [outlet] if category == "positive" else []}
                    manifest["cases"].append({"id": case_id, "document_id": case_id, "split": split,
                        "tags": sorted(REQUIRED_TAGS), "input_variant": "other_raster", "image_path": image.name,
                        "source_sha256": digest, "status": "reviewed", "review": manifest["policy_review"],
                        "expected": expected})
                    if split == "held_out":
                        continue
                    for task, targets in expected.items():
                        if task != "roof_roi" and category == "no-roof":
                            continue
                        directory = root / "runs" / f"{case_id}-{task}"
                        directory.mkdir(parents=True)
                        result = {"request_id": directory.name, "case_id": case_id, "task": task,
                                  "source_sha256": digest, "status": "complete" if targets else "no_detections",
                                  "annotations": targets}
                        request = {"request_id": directory.name, "case_id": case_id, "task": task,
                                   "image": {"source_sha256": digest}, "model": "gemini-3.6-flash",
                                   "config_sha256": "test-config", "profile": "json", "provider": "developer",
                                   "generation_config": {"max_output_tokens": 4096},
                                   "accepted_rois": {"rois": [{"id": "roof", "box_2d": roof["box_2d"]}]}}
                        write_json(directory / "result.json", result)
                        write_json(directory / "request.json", request)
            manifest_path = root / "manifest.json"
            write_json(manifest_path, manifest)
            report = evaluate(manifest_path, root / "runs", "development", 0.5)
            self.assertEqual(report["precision"], 1)
            self.assertEqual(report["recall"], 1)
            with self.assertRaisesRegex(ReferenceError, "missing_evaluation_run"):
                evaluate(manifest_path, root / "runs", "held_out", 0.5)
            path = root / "runs/development-positive-roof_roi/result.json"
            partial = json.loads(path.read_text())
            partial["status"] = "partial"
            path.write_text(json.dumps(partial))
            with self.assertRaisesRegex(ReferenceError, "failed_or_partial_evaluation_run"):
                evaluate(manifest_path, root / "runs", "development", 0.5)
            duplicate = root / "runs/duplicate"
            duplicate.mkdir()
            write_json(duplicate / "result.json", deepcopy(partial))
            write_json(duplicate / "request.json", {})
            with self.assertRaisesRegex(ReferenceError, "duplicate_case_task_run"):
                evaluate(manifest_path, root / "runs", "development", 0.5)