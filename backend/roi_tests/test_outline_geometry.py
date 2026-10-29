from io import BytesIO
import math
import unittest

from PIL import Image, ImageDraw

from backend.app.errors import RoiError
from backend.app.outline_geometry import prepare_outline_crop, refine_outline_polygons


def drawing(size=(400, 300), rings=()):
    image = Image.new("RGB", size, "white")
    draw = ImageDraw.Draw(image)
    for ring in rings:
        draw.line(ring + ring[:1], fill="black", width=1)
    stream = BytesIO()
    image.save(stream, format="PNG")
    return stream.getvalue()


def normalized(points, crop):
    return [{"x": (x - crop["x"]) * 1000 / crop["width"],
             "y": (y - crop["y"]) * 1000 / crop["height"]} for x, y in points]


def vectors(points):
    return [{"start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}}
            for a, b in zip(points, points[1:] + points[:1])]


class OutlineGeometryTests(unittest.TestCase):
    def refine(self, rings, *, image=None, box=(0, 0, 1000, 1000), segments=None):
        image = image or drawing()
        crop = prepare_outline_crop(image, box)
        return refine_outline_polygons(image, box, crop.crop, [normalized(ring, crop.crop) for ring in rings], segments)

    def assert_points(self, actual, expected, places=5):
        self.assertEqual(len(actual), len(expected))
        for point, (x, y) in zip(actual, expected):
            self.assertAlmostEqual(point["x"], x, places=places)
            self.assertAlmostEqual(point["y"], y, places=places)

    def test_crop_uses_original_detail_and_records_exact_page_transform(self):
        image = drawing((4000, 2000))
        crop = prepare_outline_crop(image, (250, 250, 750, 750))
        self.assertEqual((crop.source_width, crop.source_height), (4000, 2000))
        self.assertEqual(crop.crop, {"x": 880, "y": 380, "width": 2240, "height": 1240,
                                     "inference_width": 2048, "inference_height": 1134})
        with Image.open(BytesIO(crop.png)) as raster:
            self.assertEqual(raster.size, (2048, 1134))
        # The mask's coordinates refer to the crop, not the thumbnail size.
        ring = [(1000, 500), (3000, 500), (3000, 1500), (1000, 1500)]
        result = refine_outline_polygons(image, (250, 250, 750, 750), crop.crop,
                                         [normalized(ring, crop.crop)], vectors(ring))
        self.assert_points(result["proposals"][0]["points"], ring)

    def test_stepped_roof_fits_vector_evidence_preserving_all_returns(self):
        ring = [(40, 170), (120, 170), (120, 70), (200, 70), (200, 100), (340, 100),
                (340, 220), (160, 220), (160, 270), (80, 270), (80, 190), (40, 190)]
        proposed = [(x + .8, y + 1.2) for x, y in ring]
        result = self.refine([proposed], image=drawing(rings=[ring]), segments=vectors(ring))
        self.assertEqual(result["status"], "complete")
        self.assert_points(result["proposals"][0]["points"], ring)
        self.assert_points(result["proposals"][0]["proposed_points"], proposed)
        self.assertTrue(all(edge["source"] == "vector" and edge["support"] > .9
                            for edge in result["proposals"][0]["edges"]))

    def test_already_correct_outline_is_stable_and_collinear_vertices_removed(self):
        ring = [(50, 50), (150, 50), (250, 50), (250, 200), (50, 200), (50, 50)]
        expected = [ring[index] for index in (0, 2, 3, 4)]
        result = self.refine([ring], image=drawing(rings=[expected]), segments=vectors(expected))
        self.assert_points(result["proposals"][0]["points"], expected)
        again = self.refine([expected], image=drawing(rings=[expected]), segments=vectors(expected))
        self.assertEqual(result["proposals"][0]["points"], again["proposals"][0]["points"])

    def test_raster_only_fits_visible_lines_without_dilating_scope(self):
        ring = [(50, 50), (300, 50), (300, 220), (50, 220)]
        result = self.refine([[(x + 2, y + 2) for x, y in ring]], image=drawing(rings=[ring]))
        self.assertEqual(result["status"], "complete")
        self.assert_points(result["proposals"][0]["points"], ring)
        self.assertTrue(all(edge["source"] == "raster" for edge in result["proposals"][0]["edges"]))

    def test_diagonal_rotated_roof_retains_its_directions(self):
        angle = math.radians(23)
        ring = [(180 + x * math.cos(angle) - y * math.sin(angle),
                 150 + x * math.sin(angle) + y * math.cos(angle))
                for x, y in [(-100, -50), (100, -50), (100, 50), (-100, 50)]]
        proposed = [(x + 1, y + 1) for x, y in ring]
        result = self.refine([proposed], image=drawing(rings=[ring]), segments=vectors(ring))
        self.assertEqual(result["status"], "complete")
        self.assert_points(result["proposals"][0]["points"], ring)

    def test_parallel_parapet_faces_require_review_instead_of_arbitrary_snap(self):
        ring = [(100, 100), (900, 100), (900, 700), (100, 700)]
        alternate = {"start": {"x": 100, "y": 104}, "end": {"x": 900, "y": 104}}
        result = self.refine([ring], image=drawing((1000, 800), [ring]), segments=vectors(ring) + [alternate])
        self.assertEqual(result["status"], "needs_review")
        self.assertIn("ambiguous_parallel_edges", result["warnings"])
        self.assertTrue(result["proposals"][0]["edges"][0]["ambiguous"])
        self.assert_points(result["proposals"][0]["points"], ring)

    def test_unsupported_gap_is_not_bridged_or_reported_as_confident(self):
        ring = [(50, 50), (350, 50), (350, 250), (50, 250)]
        fragments = [{"start": {"x": 50, "y": 50}, "end": {"x": 70, "y": 50}},
                     {"start": {"x": 330, "y": 50}, "end": {"x": 350, "y": 50}}]
        result = self.refine([ring], segments=fragments)
        self.assertEqual(result["status"], "needs_review")
        self.assertIn("unsupported_boundary_segments", result["warnings"])
        self.assert_points(result["proposals"][0]["points"], ring)
        self.assertEqual(result["proposals"][0]["edges"][0]["source"], "unsupported")

    def test_weak_vector_support_always_requires_review(self):
        ring = [(50, 50), (350, 50), (350, 250), (50, 250)]
        segments = vectors(ring)
        segments[0]["end"]["x"] = 200
        result = self.refine([ring], segments=segments)
        self.assertEqual(result["status"], "needs_review")
        self.assertIn("unsupported_boundary_segments", result["warnings"])
        self.assertEqual(result["proposals"][0]["edges"][0]["support"], .5)

    def test_serialization_keeps_fractional_roi_boundary_inside_its_exact_bounds(self):
        left, top, right, bottom = 40.123456789, 33.987654321, 335.678901234, 244.345678912
        ring = [(left, top), (right, top), (right, bottom), (left, bottom)]
        box = (top / 300 * 1000, left / 400 * 1000, bottom / 300 * 1000, right / 400 * 1000)
        result = self.refine([ring], box=box, segments=vectors(ring))
        self.assert_points(result["proposals"][0]["points"], ring, places=8)
        for key in ("points", "proposed_points"):
            for point in result["proposals"][0][key]:
                self.assertGreaterEqual(point["x"], box[1] * 400 / 1000)
                self.assertLessEqual(point["x"], box[3] * 400 / 1000)
                self.assertGreaterEqual(point["y"], box[0] * 300 / 1000)
                self.assertLessEqual(point["y"], box[2] * 300 / 1000)

    def test_roi_too_tight_does_not_clip_or_create_rectangle_edge(self):
        ring = [(70, 70), (330, 70), (330, 230), (70, 230)]
        result = self.refine([ring], box=(250, 200, 750, 800))
        self.assertEqual(result, {"status": "roi_too_tight", "proposals": [], "warnings": ["scope_outside_roi"]})

    def test_roi_boundary_contact_is_reported_even_with_support(self):
        ring = [(80, 60), (320, 60), (320, 240), (80, 240)]
        result = self.refine([ring], box=(200, 200, 800, 800), segments=vectors(ring))
        self.assertEqual(result["status"], "needs_review")
        self.assertIn("roi_boundary_contact", result["warnings"])

    def test_rejects_crossings_self_touching_retracing_and_nested_holes(self):
        cases = [
            [[(50, 50), (250, 200), (250, 50), (50, 200)]],
            [[(50, 50), (250, 50), (250, 200), (150, 50), (50, 200)]],
            [[(50, 50), (250, 50), (150, 50), (250, 200), (50, 200)]],
            [[(50, 50), (250, 50), (250, 200), (50, 200)], [(80, 80), (100, 80), (100, 100), (80, 100)]],
            [[(50, 50), (200, 50), (200, 200), (50, 200)], [(200, 80), (300, 80), (300, 150), (200, 150)]],
        ]
        for rings in cases:
            with self.subTest(rings=rings), self.assertRaises(RoiError) as caught:
                self.refine(rings)
            self.assertEqual(caught.exception.code, "invalid_outline_geometry")

    def test_multiple_disjoint_scopes_are_preserved_and_empty_is_valid(self):
        rings = [[(30, 30), (150, 30), (150, 130), (30, 130)],
                 [(220, 150), (350, 150), (350, 250), (220, 250)]]
        result = self.refine(rings, image=drawing(rings=rings), segments=sum([vectors(ring) for ring in rings], []))
        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(result["proposals"]), 2)
        self.assertEqual(self.refine([]), {"status": "no_outline", "proposals": [], "warnings": []})

    def test_invalid_numbers_limits_and_crop_transform_are_rejected(self):
        image = drawing()
        crop = prepare_outline_crop(image, (0, 0, 1000, 1000)).crop
        cases = [[[{"x": 10, "y": 10}, {"x": 900, "y": 10}, {"x": float("nan"), "y": 900}]],
                 [[{"x": 10, "y": 10}, {"x": True, "y": 10}, {"x": 900, "y": 900}]],
                 [[{"x": 10, "y": 10}, {"x": 1001, "y": 10}, {"x": 900, "y": 900}]],
                 [[{"x": 10, "y": 10}] * 129]]
        for polygons in cases:
            with self.subTest(polygons=polygons), self.assertRaises(RoiError):
                refine_outline_polygons(image, (0, 0, 1000, 1000), crop, polygons)
        with self.assertRaises(RoiError):
            refine_outline_polygons(image, (0, 0, 1000, 1000), {**crop, "x": -1}, [])
        with self.assertRaises(RoiError):
            refine_outline_polygons(image, (0, 0, 1000, 1000), crop, [], [{}] * 2001)


if __name__ == "__main__":
    unittest.main()
