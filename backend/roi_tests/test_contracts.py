import json
import unittest

from pydantic import ValidationError

from backend.roi_app.config import Settings
from backend.roi_app.errors import OutputDiagnostic, RoiError
from backend.roi_app.models import DetectionInput, Geometry
from backend.roi_app.parsing import parse_proposals


class ContractTests(unittest.TestCase):
    def test_config_requires_selected_model_local_origins_and_bounded_retries(self):
        for changes in ({"model": "another-model"}, {"allowed_origins": ("*",)},
                        {"allowed_origins": ("https://remote.example",)}, {"max_attempts": 3}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                Settings(**changes)
        self.assertNotIn("api_key", Settings(api_key="synthetic-key").model_dump())
        self.assertNotIn("synthetic-key", repr(Settings(api_key="synthetic-key")))

    def test_fractional_box_and_invalid_geometry(self):
        self.assertEqual(Geometry(box_2d=[0.25, 10, 900, 999.9]).box_2d[0], 0.25)
        for box in ([1, 2, 1, 4], [0, 2, 3, 1], [-1, 0, 3, 4], [0, 0, 1001, 3],
                    [False, 0, 3, 4], ["0", 0, 3, 4], [0, 0, float("nan"), 4], [0, 1, 2]):
            with self.subTest(box=box), self.assertRaises(ValidationError):
                Geometry(box_2d=box)

    def test_child_requires_unique_accepted_parents(self):
        request = dict(page_id="page", request_id="request", task="penetration",
                       source_image_hash="a" * 64, roi_revision=1, geometry_revision=0)
        with self.assertRaises(ValidationError):
            DetectionInput(**request)
        parent = dict(id="roi", revision=1, box_2d=[0, 0, 500, 500])
        self.assertEqual(DetectionInput(**request, accepted_rois=[parent]).accepted_rois[0].id, "roi")
        with self.assertRaises(ValidationError):
            DetectionInput(**request, accepted_rois=[parent, parent])

    def test_strict_json_and_fence_compatibility(self):
        self.assertEqual(parse_proposals("```json\n[]\n```", "roof_roi", set(), 1024, 25), [])
        for text in ('prose []', '[{"label":"a","label":"b","box_2d":[0,0,3,4]}]',
                     '[{"label":"a","box_2d":[0,0,NaN,4]}]', '[', '{}',
                     '[{"label":"a","box_2d":[0,0,3,4],"kind":"roof_roi"}]'):
            with self.subTest(text=text), self.assertRaises(RoiError):
                parse_proposals(text, "roof_roi", set(), 1024, 25)

    def test_single_json_fence_variants_preserve_fractional_geometry(self):
        record = '[{"label":"Roof","box_2d":[1.25,2.5,300,400]}]'
        for text in (f"```json\r\n{record}\r\n```", f"```JSON\n{record}\n```",
                     f"```\n{record}\n```", f"  ```json \n{record}\n```  "):
            with self.subTest(text=text):
                proposals = parse_proposals(text, "roof_roi", set(), 1024, 25)
                self.assertEqual(proposals[0].box_2d, (1.25, 2.5, 300, 400))

    def test_fence_compatibility_does_not_extract_json_from_prose_or_multiple_blocks(self):
        for text in ("Here are results:\n```json\n[]\n```", "```json\n[]\n```\nExplanation",
                     "```json\n[]\n```\n```json\n[]\n```", "```python\n[]\n```",
                     "```json\n[]", "```json\n[{\"label\":\"Roof\",\"box_2d\":[4,2,1,3]}]\n```"):
            with self.subTest(text=text), self.assertRaises(RoiError):
                parse_proposals(text, "roof_roi", set(), 1024, 25)

    def test_child_association_and_limits(self):
        text = '[{"label":"Vent","box_2d":[1,2,3,4],"roi_id":"roi","subtype":"vent"}]'
        self.assertEqual(len(parse_proposals(text, "penetration", {"roi"}, 1024, 25)), 1)
        for task, parents, size, count in (("penetration", {"other"}, 1024, 25),
                                           ("rainwater_outlet", {"roi"}, 1024, 25),
                                           ("penetration", {"roi"}, 10, 25),
                                           ("penetration", {"roi"}, 1024, 0)):
            with self.subTest(task=task, parents=parents), self.assertRaises(RoiError):
                parse_proposals(text, task, parents, size, count)

    def test_output_diagnostics_classify_without_returning_provider_text(self):
        cases = (
            (" ", OutputDiagnostic.EMPTY_TEXT),
            ("private provider text", OutputDiagnostic.JSON_SYNTAX),
            ('{"private": "text"}', OutputDiagnostic.JSON_STRUCTURE),
            ('[{"label":"private"}]', OutputDiagnostic.ANNOTATION_FIELDS),
            ('[{"label":"private","box_2d":[400,0,100,200]}]', OutputDiagnostic.ANNOTATION_GEOMETRY),
            ('[{"label":{"private":"text"},"box_2d":[0,0,100,200]}]', OutputDiagnostic.ANNOTATION_LABEL),
        )
        for text, category in cases:
            with self.subTest(category=category), self.assertRaises(RoiError) as raised:
                parse_proposals(text, "roof_roi", set(), 1024, 25)
            self.assertEqual(raised.exception.diagnostic, category)
            self.assertEqual(str(raised.exception), "malformed_output")
            self.assertFalse(raised.exception.retryable)
        for parent in ("unknown", []):
            text = json.dumps([{"label": "Vent", "box_2d": [1, 2, 3, 4], "subtype": "vent", "roi_id": parent}])
            with self.assertRaises(RoiError) as raised:
                parse_proposals(text, "penetration", {"roi"}, 1024, 25)
            self.assertEqual(raised.exception.diagnostic, OutputDiagnostic.ANNOTATION_ASSOCIATION)