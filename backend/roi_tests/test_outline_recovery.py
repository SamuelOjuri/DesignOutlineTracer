"""Wider snapping is allowed only for isolated, corner-anchored missing edges."""
from io import BytesIO
import math
import unittest

from PIL import Image, ImageDraw

from backend.app import outline_geometry as g


ROOF = [(200., 200.), (1000., 200.), (1000., 1000.), (200., 1000.)]
MODEL = [(200., 200.), (1000., 200.), (1000., 982.), (200., 982.)]


def lines(ring):
    return list(zip(ring, ring[1:] + ring[:1]))


def refine(rings, segments, *, raster_segments=None, box=(0, 0, 1000, 1000),
           policy="inner_parapet", cleanup="none", prepared=True):
    image = Image.new("RGB", (1200, 1200), "white")
    draw = ImageDraw.Draw(image)
    for a, b in segments if raster_segments is None else raster_segments:
        draw.line([a, b], fill="black", width=1)
    stream = BytesIO()
    image.save(stream, format="PNG")
    png = stream.getvalue()
    crop = g.prepare_outline_crop(png, box)
    polygons = [[{"x": (x - crop.crop["x"]) * 1000 / crop.crop["width"],
                  "y": (y - crop.crop["y"]) * 1000 / crop.crop["height"]} for x, y in ring] for ring in rings]
    vectors = [{"start": {"x": a[0], "y": a[1]}, "end": {"x": b[0], "y": b[1]}} for a, b in segments]
    return g.refine_outline_polygons(png, box, crop.crop, polygons, vectors,
                                    boundary_policy=policy, cleanup=cleanup,
                                    source=crop.source if prepared else None)


class UnsupportedEdgeRecoveryTests(unittest.TestCase):
    def assert_ring(self, proposal, expected):
        self.assertEqual(len(proposal["points"]), len(expected))
        for point, (x, y) in zip(proposal["points"], expected):
            self.assertAlmostEqual(point["x"], x)
            self.assertAlmostEqual(point["y"], y)

    def test_recovers_inward_and_outward_errors_with_evidence_and_original_preserved(self):
        for y in (982., 1018.):
            for cleanup in ("none", "shapely"):
                with self.subTest(y=y, cleanup=cleanup):
                    model = [ROOF[0], ROOF[1], (1000., y), (200., y)]
                    result = refine([model], lines(ROOF), cleanup=cleanup)
                    proposal = result["proposals"][0]
                    self.assert_ring(proposal, ROOF)
                    self.assertEqual(proposal["proposed_points"], [{"x": x, "y": y} for x, y in model])
                    self.assertEqual(result["status"], "needs_review")
                    self.assertEqual(result["warnings"], ["boundary_edges_recovered"])
                    self.assertEqual([edge["index"] for edge in proposal["edges"]], list(range(4)))
                    self.assertTrue(all(edge["source"] == "vector" and edge["support"] == 1.
                                        and not edge["ambiguous"] for edge in proposal["edges"]))

    def test_unsafe_distant_corner_does_not_cancel_supported_bottom_recovery(self):
        # Moving the first line just 4 px makes its shallow junction with the
        # second edge move 40 px. Retain that line, but still recover the bottom.
        model = [(200, 200), (600, 200), (1000, 240), (1000, 982), (200, 982)]
        segments = [((200, 196), (600, 196)), ((600, 200), (1000, 240)),
                    ((1000, 240), (1000, 1000)), ((1000, 1000), (200, 1000)),
                    ((200, 1000), (200, 196))]
        for reverse, start in ((False, 0), (False, 3), (True, 1)):
            ring = list(reversed(model)) if reverse else model
            ring = ring[start:] + ring[:start]
            with self.subTest(reverse=reverse, start=start):
                proposal = refine([ring], segments)["proposals"][0]
                expected = [(x, 1000 if y == 982 else y) for x, y in ring]
                self.assert_ring(proposal, expected)
                self.assertEqual(proposal["proposed_points"], [{"x": x, "y": y} for x, y in ring])
                self.assertIn("local_fitting_limited", proposal["warnings"])
                self.assertIn("boundary_edges_recovered", proposal["warnings"])
                self.assertNotIn("fitting_rejected", proposal["warnings"])
                top = next(i for i, (a, b) in enumerate(lines(ring)) if a[1] == b[1] == 200)
                bottom = next(i for i, (a, b) in enumerate(lines(ring)) if a[1] == b[1] == 982)
                self.assertTrue(proposal["edges"][top]["ambiguous"])
                self.assertEqual(proposal["edges"][bottom],
                                 {"index": bottom, "support": 1., "source": "vector", "ambiguous": False})

    def test_limited_corner_does_not_relax_total_area_budget_or_allow_roi_escape(self):
        model = [(200, 200), (600, 200), (1000, 240), (1000, 500), (200, 500)]
        segments = [((200, 196), (600, 196)), ((600, 200), (1000, 240)),
                    ((1000, 240), (1000, 518)), ((1000, 518), (200, 518)),
                    ((200, 518), (200, 196))]
        # The 18 px bottom recovery would exceed the 4% global area allowance.
        proposal = refine([model], segments)["proposals"][0]
        self.assert_ring(proposal, model)
        self.assertIn("local_fitting_limited", proposal["warnings"])
        self.assertNotIn("boundary_edges_recovered", proposal["warnings"])
        # A shifted line outside the ROI must stay at its original position.
        roof = [(200, 196), (1000, 196), (1000, 982), (200, 982)]
        model = [(200, 200), (1000, 200), (1000, 980), (200, 980)]
        proposal = refine([model], lines(roof), box=(200 / 1.2, 0, 1000, 1000))["proposals"][0]
        self.assert_ring(proposal, [(200, 200), (1000, 200), (1000, 982), (200, 982)])
        self.assertIn("local_fitting_limited", proposal["warnings"])
        self.assertTrue(all(p["y"] >= 200 for p in proposal["points"]))

    def test_rotation_winding_ring_start_and_policy_do_not_change_recovery(self):
        for angle, reverse, start, policy in [(0, False, 2, "inner_parapet"),
                                              (90, True, 3, "outer_roof"),
                                              (23, False, 1, "roof_deck"),
                                              (203, True, 2, "inner_parapet")]:
            with self.subTest(angle=angle, reverse=reverse, policy=policy):
                radians = math.radians(angle)
                transform = lambda p: (600 + (p[0] - 600) * math.cos(radians) - (p[1] - 600) * math.sin(radians),
                                       600 + (p[0] - 600) * math.sin(radians) + (p[1] - 600) * math.cos(radians))
                rings = []
                for ring in (MODEL, ROOF):
                    shifted = ring[start:] + ring[:start]
                    rings.append([transform(p) for p in (list(reversed(shifted)) if reverse else shifted)])
                proposal = refine([rings[0]], lines(rings[1]), policy=policy)["proposals"][0]
                self.assert_ring(proposal, rings[1])
                self.assertIn("boundary_edges_recovered", proposal["warnings"])

    def test_small_region_uses_a_proportionally_smaller_search(self):
        roof = [(200, 200), (280, 200), (280, 300), (200, 300)]
        # This region has a 2 px ordinary radius, so 3 px qualifies and 5 px does not.
        for error in (3, 5):
            with self.subTest(error=error):
                model = [roof[0], roof[1], (280, 300 - error), (200, 300 - error)]
                proposal = refine([model], lines(roof), box=(150, 150, 270, 250))["proposals"][0]
                self.assert_ring(proposal, roof if error == 3 else model)
                self.assertEqual("boundary_edges_recovered" in proposal["warnings"], error == 3)

    def test_contiguous_fragments_and_subpixel_joins_match_whole_line_and_prepared_raster(self):
        segments = lines(ROOF)
        segments[2:3] = [((1000, 1000), (700, 1000)), ((699.5, 1000), (400, 1000)),
                         ((400, 1000), (200, 1000))]
        result = refine([MODEL], segments)
        self.assert_ring(result["proposals"][0], ROOF)
        self.assertEqual(result, refine([MODEL], segments, prepared=False))

    def test_gap_is_rejected_even_when_aggregate_coverage_exceeds_98_percent(self):
        segments = lines(ROOF)
        segments[2:3] = [((1000, 1000), (606, 1000)), ((594, 1000), (200, 1000))]
        proposal = refine([MODEL], segments)["proposals"][0]
        self.assert_ring(proposal, MODEL)
        self.assertEqual(proposal["edges"][2]["source"], "unsupported")
        self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_dimension_line_without_finite_corner_connections_cannot_recover(self):
        for gap_at in (1, 3):
            with self.subTest(gap_at=gap_at):
                segments = lines(ROOF)
                # Both side lines still support the entire model. One stops at
                # y=982 instead of reaching the apparent boundary at y=1000.
                segments[gap_at] = lines(MODEL)[gap_at]
                proposal = refine([MODEL], segments)["proposals"][0]
                self.assert_ring(proposal, MODEL)
                self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_two_continuous_anchored_parallel_faces_remain_ambiguous_for_all_policies(self):
        segments = lines(ROOF) + [((200, 996), (1000, 996))]
        for policy in ("inner_parapet", "outer_roof", "roof_deck"):
            with self.subTest(policy=policy):
                proposal = refine([MODEL], segments, policy=policy)["proposals"][0]
                self.assert_ring(proposal, MODEL)
                self.assertTrue(proposal["edges"][2]["ambiguous"])
                self.assertIn("ambiguous_parallel_edges", proposal["warnings"])
                self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_supported_or_locally_ambiguous_edges_never_search_farther(self):
        for near in (982, 986):
            with self.subTest(near=near):
                segments = lines(ROOF) + [((200, near), (1000, near))]
                if near == 986:
                    segments.append(((200, 978), (1000, 978)))
                proposal = refine([MODEL], segments)["proposals"][0]
                self.assert_ring(proposal, MODEL)
                self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_raster_only_and_unsupported_adjoining_sides_do_not_recover(self):
        for segments in ([], [lines(ROOF)[2]], lines(ROOF)[:3]):
            with self.subTest(vector_count=len(segments)):
                proposal = refine([MODEL], segments, raster_segments=lines(ROOF))["proposals"][0]
                self.assert_ring(proposal, MODEL)
                self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_radius_length_and_area_limits_reject_large_corrections(self):
        cases = [
            # Beyond twice the ordinary radius.
            ([(200, 200), (1000, 200), (1000, 975), (200, 975)], ROOF),
            # An 18 px correction exceeds 4% of this shallow roof's area.
            ([(200, 700), (1000, 700), (1000, 982), (200, 982)],
             [(200, 700), (1000, 700), (1000, 1000), (200, 1000)]),
            # Short edges must not move by a large fraction of their own length.
            ([(200, 200), (280, 200), (280, 982), (200, 982)],
             [(200, 200), (280, 200), (280, 1000), (200, 1000)]),
        ]
        for model, roof in cases:
            with self.subTest(model=model):
                proposal = refine([model], lines(roof))["proposals"][0]
                self.assert_ring(proposal, model)
                self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_ordinary_fit_and_recovery_share_one_area_budget(self):
        # Bottom recovery alone would add 3.6%; moving the left side 10 px
        # during ordinary fitting would take the combined change above 4%.
        model = [(210, 482), (1000, 482), (1000, 982), (210, 982)]
        roof = [(200, 482), (1000, 482), (1000, 1000), (200, 1000)]
        proposal = refine([model], lines(roof))["proposals"][0]
        self.assert_ring(proposal, [(200, 482), (1000, 482), (1000, 982), (200, 982)])
        self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_multiple_recoveries_cannot_spend_the_area_allowance_separately(self):
        model = [(200, 218), (1000, 218), (1000, 982), (200, 982)]
        proposal = refine([model], lines(ROOF))["proposals"][0]
        self.assert_ring(proposal, model)
        self.assertIn("fitting_rejected", proposal["warnings"])
        self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_multiple_isolated_edges_can_recover_within_the_shared_budget(self):
        model = [(200, 215), (1000, 215), (1000, 985), (200, 985)]
        proposal = refine([model], lines(ROOF))["proposals"][0]
        self.assert_ring(proposal, ROOF)
        self.assertEqual(proposal["warnings"], ["boundary_edges_recovered"])
        self.assertTrue(all(edge["source"] == "vector" and edge["support"] == 1. for edge in proposal["edges"]))

    def test_two_adjacent_unsupported_edges_cannot_bootstrap_each_other(self):
        model = [(200, 200), (982, 200), (982, 982), (200, 982)]
        proposal = refine([model], lines(ROOF))["proposals"][0]
        self.assert_ring(proposal, model)
        self.assertNotIn("boundary_edges_recovered", proposal["warnings"])

    def test_recovery_stays_inside_roi_and_preserves_separate_components(self):
        result = refine([MODEL], lines(ROOF), box=(0, 0, 990 / 1.2, 1000))
        self.assert_ring(result["proposals"][0], MODEL)
        island = [(500, 987), (520, 987), (520, 994), (500, 994)]
        result = refine([MODEL, island], lines(ROOF) + lines(island))
        self.assert_ring(result["proposals"][0], MODEL)
        self.assert_ring(result["proposals"][1], island)
        self.assertIn("component_conflict", result["warnings"])
        self.assertNotIn("boundary_edges_recovered", result["warnings"])

    def test_roi_contact_is_reported_for_a_recovered_edge(self):
        result = refine([MODEL], lines(ROOF), box=(0, 0, 1000 / 1.2, 1000))
        self.assert_ring(result["proposals"][0], ROOF)
        self.assertIn("roi_boundary_contact", result["warnings"])
