import json
import unittest

from backend.roi_reference.contracts import ReferenceError, parse_response


class ResponseTests(unittest.TestCase):
    def test_plain_and_fenced_json_preserve_fractional_coordinates(self):
        records = [{"label": "Synthetic roof", "box_2d": [10.25, 20, 400, 600]}]
        text = json.dumps(records)
        self.assertEqual(parse_response(text), records)
        self.assertEqual(parse_response(f"```json\n{text}\n```"), records)
        self.assertEqual(parse_response("[]"), [])

    def test_rejects_invalid_geometry_without_repair(self):
        for box in (
            [100, 200, 10, 300], [0, 0, 0, 10], [-1, 0, 20, 20],
            [0, 0, 1001, 20], [True, 0, 20, 20], [0, 0, float("nan"), 20],
            [0, 0, float("inf"), 20], [0, 0, "20", 20], [0, 0, 20],
        ):
            with self.subTest(box=box), self.assertRaises(ReferenceError):
                parse_response(json.dumps([{"label": "Synthetic roof", "box_2d": box}]))

    def test_rejects_prose_truncation_duplicate_keys_and_unknown_fields(self):
        for text in (
            'Here are the boxes: []', '```json\n[]\n``` trailing prose', '[', '{}',
            '[{"label":"a","label":"b","box_2d":[0,0,10,10]}]',
            '[{"label":"a","box_2d":[0,0,10,10],"id":"model-id"}]',
        ):
            with self.subTest(text=text), self.assertRaises(ReferenceError):
                parse_response(text)

    def test_child_requires_known_parent_and_controlled_subtype(self):
        record = {"label": "Synthetic vent", "box_2d": [1, 1, 2, 2],
                  "roi_id": "roi-1", "subtype": "vent"}
        self.assertEqual(parse_response(json.dumps([record]), "penetration", ("roi-1",)), [record])
        with self.assertRaisesRegex(ReferenceError, "unknown_parent"):
            parse_response(json.dumps([record]), "penetration", ("roi-2",))
        record["subtype"] = "arbitrary_equipment"
        with self.assertRaisesRegex(ReferenceError, "invalid_subtype"):
            parse_response(json.dumps([record]), "penetration", ("roi-1",))

    def test_response_limits(self):
        record = {"label": "Synthetic roof", "box_2d": [0, 0, 10, 10]}
        with self.assertRaisesRegex(ReferenceError, "annotation_limit_exceeded"):
            parse_response(json.dumps([record] * 26))
        with self.assertRaisesRegex(ReferenceError, "response_too_large"):
            parse_response(" " * (256 * 1024 + 1))