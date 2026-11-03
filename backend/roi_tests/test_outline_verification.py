"""Perimeter-wide verification and joint correction of disconnected boundaries."""
import math
import unittest

from backend.app import outline_geometry as g
from test_outline_continuity import refine, lines


# Reduced source geometry from 251004. Coordinates are test data only.
INNER = [(1371.12, 1241.84), (1656, 1241.84), (1656, 2448.08),
         (385.92, 2448.08), (385.92, 1713.92), (1371.12, 1713.92)]
OUTER = [(1371.12, 1236.08), (1661.76, 1236.08), (1661.76, 2453.6),
         (380.4, 2453.6), (380.4, 1719.44), (1371.12, 1719.44)]
MODEL = [(1368.8, 1195.64), (1660.36, 1195.64), *INNER[2:5], (1368.8, 1713.92)]
DISTRACTORS = [((1371.12, 1194.8), (1708.56, 1194.8)),
               ((1371.12, 1189.28), (1708.56, 1189.28))]


class PerimeterVerificationTests(unittest.TestCase):
    def test_top_overshoot_is_corrected_using_connected_inner_faces(self):
        for prepared in (False, True):
            result = refine([MODEL], lines(INNER) + lines(OUTER) + DISTRACTORS, prepared=prepared)
            proposal = result['proposals'][0]
            self.assertIn('boundary_alignment_corrected', proposal['warnings'])
            self.assertEqual(len(proposal['points']), 6)
            for actual, expected in zip(proposal['points'], INNER):
                self.assertLess(g._distance((actual['x'], actual['y']), expected), 1e-6)
            self.assertAlmostEqual(proposal['proposed_points'][0]['y'], 1195.64)
            self.assertEqual(result['status'], 'needs_review')

    def test_rotation_winding_and_start_cover_every_side_and_diagonals(self):
        for angle, reverse in ((90, False), (180, True), (270, False), (23, True)):
            theta = math.radians(angle)
            transform = lambda p: (1500+(p[0]-1500)*math.cos(theta)-(p[1]-1500)*math.sin(theta),
                                   1500+(p[0]-1500)*math.sin(theta)+(p[1]-1500)*math.cos(theta))
            ring = MODEL[3:] + MODEL[:3]
            if reverse:
                ring.reverse()
            source = [(transform(a), transform(b)) for a, b in lines(INNER)+lines(OUTER)+DISTRACTORS]
            with self.subTest(angle=angle, reverse=reverse):
                proposal = refine([[transform(p) for p in ring]], source)['proposals'][0]
                actual = [(p['x'], p['y']) for p in proposal['points']]
                self.assertIn('boundary_alignment_corrected', proposal['warnings'])
                for point in map(transform, INNER):
                    self.assertLess(min(g._distance(point, p) for p in actual), 1e-6)

    def test_roof_deck_can_use_a_unique_closure_established_by_verified_neighbours(self):
        proposal = refine([MODEL], lines(INNER)+lines(OUTER)+DISTRACTORS, policy='roof_deck')['proposals'][0]
        self.assertIn('boundary_alignment_corrected', proposal['warnings'])
        self.assertAlmostEqual(proposal['points'][0]['y'], 1241.84)

    def test_outer_policy_does_not_override_a_verified_inner_neighbour(self):
        proposal = refine([MODEL], lines(INNER)+lines(OUTER)+DISTRACTORS, policy='outer_roof')['proposals'][0]
        self.assertNotIn('boundary_alignment_corrected', proposal['warnings'])
        self.assertAlmostEqual(proposal['points'][0]['y'], 1195.64)
        self.assertIn('boundary_connections_unverified', proposal['warnings'])

    def test_verified_geometry_with_contrary_policy_evidence_is_flagged_not_moved(self):
        roof = [(500,500),(1800,500),(1800,1500),(500,1500)]
        outer = [(494,494),(1806,494),(1806,1506),(494,1506)]
        proposal = refine([outer],lines(roof)+lines(outer))['proposals'][0]
        self.assertIn('boundary_policy_unverified',proposal['warnings'])
        self.assertNotIn('boundary_alignment_corrected',proposal['warnings'])
        self.assertTrue(all(e['ambiguous'] for e in proposal['edges']))

    def test_true_steps_and_already_connected_edges_stay_in_place(self):
        for ring in (INNER, [(500,500),(1800,500),(1800,1500),(1200,1500),(1200,1480),(500,1480)]):
            proposal = refine([ring], lines(ring))['proposals'][0]
            self.assertNotIn('boundary_alignment_corrected', proposal['warnings'])
            self.assertNotIn('boundary_connections_unverified', proposal['warnings'])
            for actual, expected in zip(proposal['points'], ring):
                self.assertLess(g._distance((actual['x'],actual['y']), expected), 1e-6)

    def test_long_supported_line_with_missing_corner_is_flagged(self):
        ring = [(500,500),(1800,500),(1800,1500),(500,1500)]
        source = lines(ring)
        source[0] = ((520,500),(1800,500))  # >98% support, but no left corner.
        proposal = refine([ring], source)['proposals'][0]
        self.assertTrue(proposal['edges'][0]['ambiguous'])
        self.assertIn('boundary_connections_unverified', proposal['warnings'])
        self.assertNotIn('boundary_alignment_corrected', proposal['warnings'])

    def test_disconnected_dimension_and_broken_candidate_do_not_correct(self):
        for source in ([lines(INNER)[0]],
                       lines(INNER)[1:] + [((1371.12,1241.84),(1480,1241.84)),
                                            ((1490,1241.84),(1656,1241.84))]):
            proposal = refine([MODEL], source+DISTRACTORS)['proposals'][0]
            self.assertNotIn('boundary_alignment_corrected', proposal['warnings'])
            self.assertIn('boundary_connections_unverified', proposal['warnings'])

    def test_raster_only_verifies_but_does_not_make_wide_corrections(self):
        correct = refine([INNER], [], raster_segments=lines(INNER))['proposals'][0]
        self.assertNotIn('boundary_connections_unverified', correct['warnings'])
        wrong = refine([MODEL], [], raster_segments=lines(INNER)+DISTRACTORS)['proposals'][0]
        self.assertNotIn('boundary_alignment_corrected', wrong['warnings'])
        self.assertIn('boundary_connections_unverified', wrong['warnings'])

    def test_larger_error_cannot_expand_the_search_without_limit(self):
        model = [(x, y-25 if y == 1195.64 else y) for x,y in MODEL]
        proposal = refine([model], lines(INNER))['proposals'][0]
        self.assertNotIn('boundary_alignment_corrected', proposal['warnings'])

    def test_small_edges_and_shared_area_budget_limit_wider_correction(self):
        for model, roof in [
            ([(500,500),(600,500),(600,1450),(500,1450)],
             [(500,500),(600,500),(600,1500),(500,1500)]),
            ([(500,500),(1800,500),(1800,950),(500,950)],
             [(500,500),(1800,500),(1800,1000),(500,1000)])]:
            proposal = refine([model], lines(roof))['proposals'][0]
            self.assertNotIn('boundary_alignment_corrected', proposal['warnings'])

    def test_corrections_cannot_merge_separate_roofs(self):
        roof = [(500,500),(1800,500),(1800,1500),(500,1500)]
        model = [(500,500),(1800,500),(1800,1470),(500,1470)]
        island = [(900,1480),(920,1480),(920,1490),(900,1490)]
        result = refine([model,island], lines(roof)+lines(island))
        self.assertIn('component_conflict', result['warnings'])
        self.assertNotIn('boundary_alignment_corrected', result['warnings'])
        self.assertAlmostEqual(result['proposals'][0]['points'][2]['y'],1470)

    def test_multiple_corrections_share_a_symmetric_difference_budget(self):
        for height, accepted in ((1000, False), (1600, True)):
            roof = [(500,500),(1800,500),(1800,500+height),(500,500+height)]
            # Two individually small corrections: net area cancels for the
            # translated case, but total changed scope must still be bounded.
            model = [(500,530),(1800,530),(1800,530+height),(500,530+height)]
            source = [lines(roof)[0], lines(roof)[2],
                      ((500,450),(500,600+height)), ((1800,450),(1800,600+height))]
            with self.subTest(height=height):
                proposal = refine([model], source)['proposals'][0]
                self.assertEqual('boundary_alignment_corrected' in proposal['warnings'], accepted)
                expected = roof if accepted else model
                for actual, point in zip(proposal['points'], expected):
                    self.assertLess(g._distance((actual['x'],actual['y']),point),1e-6)

    def test_correction_cannot_leave_the_accepted_region(self):
        roof = [(500,500),(1800,500),(1800,1500),(500,1500)]
        model = [(500,500),(1800,500),(1800,1470),(500,1470)]
        proposal = refine([model],lines(roof),box=(0,0,1490/3,1000))['proposals'][0]
        self.assertNotIn('boundary_alignment_corrected', proposal['warnings'])

