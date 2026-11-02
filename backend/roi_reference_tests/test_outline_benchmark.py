from io import BytesIO
import json
from pathlib import Path
import tempfile
import unittest

import cv2
import numpy as np
from PIL import Image, ImageDraw
from pydantic import ValidationError

from backend.roi_reference.contracts import ReferenceError
from backend.roi_reference.outline_benchmark import (
    OutlineManifest, capture, load_outline_manifest, review_sheets, roi_vectors, score,
)
from backend.roi_reference.outline_metrics import score_outline
from backend.roi_reference.outline_references import mask_polygon, snap_reference
from backend.roi_reference.outline_side_aware import side_aware_refine


SQUARE = [(100, 100), (300, 100), (300, 300), (100, 300)]


def segment(a, b):
    return {"start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}}


def ring_segments(ring):
    return [segment(a, b) for a, b in zip(ring, ring[1:] + ring[:1])]


def offset_square(delta):
    return [(100 - delta, 100 - delta), (300 + delta, 100 - delta), (300 + delta, 300 + delta), (100 - delta, 300 + delta)]


class OutlineMetricTests(unittest.TestCase):
    def test_identical_and_shifted_outlines(self):
        exact = score_outline([SQUARE], [SQUARE])
        self.assertAlmostEqual(exact.iou, 1)
        self.assertEqual(exact.boundary_f1, {"2px": 1., "5px": 1.})
        self.assertAlmostEqual(exact.hausdorff, 0)
        shifted = score_outline([[(x + 3, y) for x, y in SQUARE]], [SQUARE])
        self.assertAlmostEqual(shifted.iou, 197 * 200 / (203 * 200))
        self.assertLess(shifted.boundary_f1["2px"], 1)
        self.assertEqual(shifted.boundary_f1["5px"], 1.)
        self.assertAlmostEqual(shifted.hausdorff, 3, places=5)

    def test_empty_prediction_scores_zero(self):
        self.assertEqual(score_outline([], [SQUARE]).iou, 0)
        with self.assertRaises(ValueError):
            score_outline([SQUARE], [])


class OutlineReferenceTests(unittest.TestCase):
    def test_edges_take_the_drawn_face_nearest_the_interior_but_ignore_interior_detail(self):
        # Faces drawn as pairs 5 px apart, plus a dimension line 12 px inside the top edge.
        segments = ring_segments(offset_square(0)) + ring_segments(offset_square(5))
        segments.append(segment((110, 112), (290, 112)))
        result = snap_reference(offset_square(1), segments)
        self.assertEqual({(round(x), round(y)) for x, y in result["points"]}, set(SQUARE))
        self.assertTrue(all(edge["source"] == "vector" for edge in result["edges"]))

    def test_paint_bleed_steps_on_a_continuous_line_are_merged(self):
        approximate = [(100, 100), (300, 100), (300, 280), (308, 280), (308, 300), (100, 300)]
        segments = ring_segments(SQUARE) + ring_segments(offset_square(5))
        result = snap_reference(approximate, segments)
        self.assertEqual({(round(x), round(y)) for x, y in result["points"]}, set(SQUARE))
        self.assertIn("vector_merged_step", {edge["source"] for edge in result["edges"]})

    def test_edges_without_lines_keep_their_approximate_position_and_say_so(self):
        result = snap_reference(SQUARE, [])
        self.assertEqual({edge["source"] for edge in result["edges"]}, {"approximate"})

    def test_mask_polygon_is_scaled_to_page_pixels(self):
        image = np.full((200, 300, 3), 255, np.uint8)
        cv2.rectangle(image, (40, 50), (139, 149), (238, 225, 173), -1)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mask.png"
            cv2.imwrite(str(path), image)
            polygon = mask_polygon(path, (86, 35, 180), (106, 130, 255), .5)
        xs, ys = [x for x, _ in polygon], [y for _, y in polygon]
        self.assertEqual((min(xs), max(xs), min(ys), max(ys)), (20, 69.5, 25, 74.5))


def page(width=400, height=300, *, band=None):
    """Blank page, or one whose roof is enclosed by a hatched wall band between two rectangles."""
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    if band:
        outer, inner = band
        for offset in range(-height, width + height, 3):
            draw.line([(offset, 0), (offset + height, height)], fill="black")
        draw.rectangle((inner[0] + 1, inner[1] + 1, inner[2] - 1, inner[3] - 1), fill="white")
        draw.rectangle((0, 0, outer[0] - 1, height), fill="white")
        draw.rectangle((outer[2] + 1, 0, width, height), fill="white")
        draw.rectangle((0, 0, width, outer[1] - 1), fill="white")
        draw.rectangle((0, outer[3] + 1, width, height), fill="white")
        draw.rectangle(outer, outline="black")
        draw.rectangle(inner, outline="black")
    stream = BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


class SideAwareTests(unittest.TestCase):
    def test_parallel_faces_resolve_to_the_face_with_open_roof_inside(self):
        from backend.app.outline_geometry import prepare_outline_crop, refine_outline_polygons

        outer, inner = (94, 94, 706, 506), (100, 100, 700, 500)
        png = page(800, 600, band=(outer, inner))
        box = [0, 0, 1000, 1000]
        crop = prepare_outline_crop(png, box).crop
        model = [(97, 97), (703, 97), (703, 503), (97, 503)]
        polygons = [[{"x": (x - crop["x"]) * 1000 / crop["width"], "y": (y - crop["y"]) * 1000 / crop["height"]}
                     for x, y in model]]
        corners = lambda r: [(r[0], r[1]), (r[2], r[1]), (r[2], r[3]), (r[0], r[3])]
        vectors = ring_segments(corners(outer)) + ring_segments(corners(inner))
        # Two equally supported parallel faces: production keeps the model edge and flags it.
        production = refine_outline_polygons(png, box, crop, polygons, vectors, cleanup="shapely")["proposals"][0]
        self.assertEqual({(round(p["x"]), round(p["y"])) for p in production["points"]}, set(model))
        self.assertIn("ambiguous_parallel_edges", production["warnings"])
        chosen = side_aware_refine(png, box, crop, polygons, vectors)["proposals"][0]
        self.assertEqual({(round(p["x"]), round(p["y"])) for p in chosen["points"]}, set(corners(inner)))
        self.assertIn("side_aware_reselection", chosen["warnings"])


class OutlineBenchmarkTests(unittest.TestCase):
    def test_committed_manifest_is_valid_and_reviews_are_enforced(self):
        manifest = load_outline_manifest()
        self.assertGreaterEqual(len(manifest.cases), 3)
        data = json.loads(manifest.model_dump_json())
        data["cases"][0]["status"] = "reviewed"
        with self.assertRaises(ValidationError):
            OutlineManifest.model_validate(data)

    def test_roi_vectors_mirror_the_frontend_filter(self):
        inside = segment((100, 100), (200, 100))
        near = segment((100, 315), (110, 315))  # within the 8% margin of a 200 px box
        far = segment((100, 500), (300, 500))
        kept = roi_vectors([near, far, inside], 1000, 1000, [100, 100, 300, 300])
        self.assertEqual(kept, [inside, near])

    def test_capture_requires_explicit_live_authorization(self):
        with self.assertRaises(ReferenceError):
            capture(None, 1, allow_live=False, max_calls=1)
        with self.assertRaises(ReferenceError):
            capture(None, 1, allow_live=True, max_calls=0)

    def test_score_reparses_captures_and_counts_parse_failures(self):
        png = page()
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            source = "a" * 64
            (cache / f"{source[:16]}-p0.png").write_bytes(png)
            square = [(100, 100), (300, 100), (300, 200), (100, 200)]
            (cache / f"{source[:16]}-p0-vectors.json").write_text(json.dumps({"segments": ring_segments(square)}))
            manifest = {"schema_version": "outline-evaluation-v1", "policy_status": "draft", "render": {}, "cases": [{
                "id": "synthetic", "document": "unused.pdf", "source_sha256": source, "page_index": 0,
                "split": "development", "tags": [], "roi_box": [0, 0, 1000, 1000], "boundary_policy": "inner_parapet",
                "status": "awaiting_review", "review": None,
                "reference": {"polygons": [[list(point) for point in square]], "method": "synthetic"}}]}
            manifest_path = cache / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            from backend.app.outline_geometry import prepare_outline_crop

            crop = prepare_outline_crop(png, [0, 0, 1000, 1000]).crop
            outline = {"polygons": [{"points": [{"x": (x - crop["x"]) * 1000 / crop["width"],
                                                  "y": (y - crop["y"]) * 1000 / crop["height"]} for x, y in square]}],
                       "roi_too_tight": False}
            captures = cache / "captures" / "synthetic"
            captures.mkdir(parents=True)
            for name, text, json_mode in (("1", "\U0001f4ad\n" + json.dumps(outline), True),
                                          ("2", "The crop shows a roof.", False)):
                (captures / f"{name}.json").write_text(json.dumps({
                    "case_id": "synthetic", "captured_at": "2026-11-02T00:00:00", "json_mode": json_mode,
                    "crop": crop, "outcome": "rejected", "polygons": None, "error": None}))
                (captures / f"{name}.txt").write_text(text, encoding="utf-8")
            report = score(["model", "production"], manifest_path=manifest_path, cache=cache)
        case = report["cases"]["synthetic"]
        self.assertEqual(case["parsed_by_mode"], {"free": "0/1", "json": "1/1"})
        self.assertTrue(report["provisional"])
        for variant in ("model", "production"):
            self.assertEqual(case["variants"][variant]["n"], 2)
            self.assertEqual(case["variants"][variant]["failures"], 1)
            self.assertAlmostEqual(case["variants"][variant]["iou_success"], 1, places=3)

    def test_review_sheets_render_offline_and_reject_unknown_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            source = "b" * 64
            (cache / f"{source[:16]}-p0.png").write_bytes(page())
            manifest = {"schema_version": "outline-evaluation-v1", "policy_status": "draft", "render": {}, "cases": [{
                "id": "synthetic", "document": "unused.pdf", "source_sha256": source, "page_index": 0,
                "split": "development", "tags": [], "roi_box": [0, 0, 1000, 1000], "boundary_policy": "inner_parapet",
                "status": "awaiting_review", "review": None,
                "reference": {"polygons": [[[100, 100], [300, 100], [300, 200], [100, 200]]], "method": "synthetic"}}]}
            manifest_path = cache / "manifest.json"
            manifest_path.write_text(json.dumps(manifest))
            result = review_sheets(manifest_path=manifest_path, cache=cache)
            sheet = Path(result["sheets"]["synthetic"]["sheet"])
            self.assertEqual(sheet.parent, cache / "review")
            with Image.open(sheet) as image:
                self.assertGreater(image.width, 0)
            with self.assertRaises(ReferenceError):
                review_sheets(["missing"], manifest_path=manifest_path, cache=cache)
