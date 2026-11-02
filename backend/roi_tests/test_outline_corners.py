"""CAD corner normalization: bounded polylines become intersections of their sides."""
import math
import unittest

from backend.app import outline_geometry as g
from test_outline_recovery import refine, lines


# Green exterior polyline extracted from the user-supplied TRICS outline PDF.
# These coordinates are a validation fixture only, never runtime input or rules.
CAD_REFERENCE = [(387.703705, 795.353760), (723.088257, 795.353760),
                 (723.088257, 564.327454), (1094.614868, 564.327454),
                 (1094.614868, 638.090088), (1600.951660, 638.090088),
                 (1600.951660, 926.974609), (872.468689, 926.974609),
                 (872.468689, 1061.836426), (536.680542, 1061.836426),
                 (536.680542, 863.320374), (387.703705, 863.320374)]
REFERENCE = [(150 + (x - 387.703705) * .7, 200 + (y - 564.327454) * .7) for x, y in CAD_REFERENCE]


def rounded(ring, index, radius, samples):
    corner, before, after = ring[index], ring[index - 1], ring[(index + 1) % len(ring)]
    incoming = [(b - a) / g._distance(before, corner) for a, b in zip(before, corner)]
    outgoing = [(b - a) / g._distance(corner, after) for a, b in zip(corner, after)]
    a = tuple(c - radius * d for c, d in zip(corner, incoming))
    b = tuple(c + radius * d for c, d in zip(corner, outgoing))
    curve = [tuple((1-t)**2*x + 2*t*(1-t)*c + t*t*y for x, c, y in zip(a, corner, b))
             for t in (i / samples for i in range(samples + 1))]
    return ring[:index] + curve + ring[index + 1:]


class CadCornerTests(unittest.TestCase):
    def assert_same_ring(self, actual, expected):
        self.assertEqual(len(actual), len(expected))
        for point in expected:
            self.assertLess(min(g._distance(point, candidate) for candidate in actual), 1e-5)

    def test_reference_corner_becomes_one_cad_vertex_for_any_sampling_density(self):
        for samples in (3, 7, 24, 48):
            with self.subTest(samples=samples):
                model = rounded(REFERENCE, 1, 20, samples)
                result = refine([model], lines(REFERENCE))
                proposal = result["proposals"][0]
                self.assert_same_ring([(p["x"], p["y"]) for p in proposal["points"]], REFERENCE)
                self.assert_same_ring([(p["x"], p["y"]) for p in proposal["proposed_points"]],
                                      g._simplify(model))
                self.assertGreater(len(proposal["proposed_points"]), len(REFERENCE))
                self.assertEqual(result["warnings"], [])
                self.assertEqual(result["status"], "complete")
                self.assertTrue(all(not edge["ambiguous"] for edge in proposal["edges"]))

    def test_rotated_reversed_convex_concave_and_oblique_corners_preserve_real_side_angles(self):
        square = [(300, 300), (900, 300), (900, 900), (300, 900)]
        for roof, index in ((square, 1), (REFERENCE, 1)):
            for angle, reverse, shear in ((0, False, 0), (23, True, 0), (-90, False, .3)):
                radians = math.radians(angle)
                def transform(p):
                    x, y = p[0] - 600 + shear * (p[1] - 600), p[1] - 600
                    return (600 + x*math.cos(radians) - y*math.sin(radians),
                            600 + x*math.sin(radians) + y*math.cos(radians))
                model = [transform(p) for p in rounded(roof, index, 20, 9)]
                expected = [transform(p) for p in roof]
                if reverse:
                    model.reverse()
                model = model[5:] + model[:5]
                with self.subTest(corner=index, angle=angle, reverse=reverse, shear=shear):
                    proposal = refine([model], lines(expected))["proposals"][0]
                    self.assert_same_ring([(p["x"], p["y"]) for p in proposal["points"]], expected)
                    self.assertNotIn("local_fitting_limited", proposal["warnings"])
                    self.assertNotIn("corner_steps_straightened", proposal["warnings"])

    def test_near_collinear_tracing_bend_does_not_hide_a_sampled_corner(self):
        model = rounded(REFERENCE, 1, 20, 4)
        # Insert a slightly off-line point on the long outgoing side, like the
        # extra tracing point that previously prevented identifying the full arc.
        a, b = model[5], model[6]
        model.insert(6, ((a[0]+b[0])/2 + 1, (a[1]+b[1])/2))
        proposal = refine([model], lines(REFERENCE))["proposals"][0]
        self.assert_same_ring([(p["x"], p["y"]) for p in proposal["points"]], REFERENCE)
        self.assertNotIn("local_fitting_limited", proposal["warnings"])

    def test_large_curves_real_returns_and_out_of_roi_intersections_are_not_squared_off(self):
        square = [(200, 200), (1000, 200), (1000, 1000), (200, 1000)]
        large_curve = rounded(square, 1, 100, 20)
        large = g._collapse_corner_steps(large_curve, 24, (0, 0, 1200, 1200))
        self.assertEqual(large, large_curve)
        notch = [(200, 200), (1000, 200), (1000, 1000), (200, 1000),
                 (200, 700), (260, 700), (260, 500), (200, 500)]
        self.assertEqual(g._collapse_corner_steps(notch, 24, (0, 0, 1200, 1200)), notch)
        # The two oblique sides meet outside the ROI, but the rounded path is inside.
        diamond = [(500, 190), (900, 590), (500, 990), (100, 590)]
        model = rounded(diamond, 0, 30, 8)
        bounds = (0, 200, 1200, 1200)
        self.assertTrue(all(bounds[1] <= y for _, y in model))
        self.assertEqual(g._collapse_corner_steps(model, 24, bounds), model)

    def test_sampled_corner_and_tracing_bend_do_not_block_distant_boundary_recovery(self):
        roof = [(200, 200), (1000, 200), (1000, 1000), (200, 1000)]
        model = rounded([(200, 200), (1000, 200), (1000, 982), (200, 982)], 1, 20, 9)
        model.insert(11, (1001, 601))
        result = refine([model], lines(roof))
        proposal = result["proposals"][0]
        self.assert_same_ring([(p["x"], p["y"]) for p in proposal["points"]], roof)
        self.assertEqual(result["warnings"], ["boundary_edges_recovered"])
        self.assertTrue(all(not edge["ambiguous"] for edge in proposal["edges"]))

    def test_shallow_bend_without_a_small_corner_transition_is_preserved(self):
        roof = [(200, 200), (1000, 200), (1000, 600), (990, 1000), (200, 1000)]
        self.assertEqual(g._straighten_traced_sides(roof, 12, (0, 0, 1200, 1200)), roof)
        proposal = refine([roof], lines(roof))["proposals"][0]
        self.assert_same_ring([(p["x"], p["y"]) for p in proposal["points"]], roof)

    def test_corner_simplification_and_fitting_share_the_area_budget(self):
        # Enlarging a rounded, small roof must not spend separate allowances for
        # corner normalization and ordinary edge fitting.
        roof = [(200, 200), (300, 200), (300, 300), (200, 300)]
        model = rounded(roof, 1, 20, 6)
        segments = lines([(198, 198), (302, 198), (302, 302), (198, 302)])
        proposal = refine([model], segments)["proposals"][0]
        actual = [(p["x"], p["y"]) for p in proposal["points"]]
        self.assertTrue(g._valid_ring(actual))
        self.assertLessEqual(abs(g._area(actual) / g._area(model) - 1), .04)
