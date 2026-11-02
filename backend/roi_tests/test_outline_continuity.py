"""Regression coverage for switching between nearby perimeter faces."""
from io import BytesIO
import math
import unittest

from PIL import Image, ImageDraw

from backend.app import outline_geometry as g


# Source coordinates from the 251004 capture, reduced to relevant perimeter linework.
MODEL = [(1372.189243, 1239.5625), (1637.364897, 1239.5625), (1637.364897, 2141.125),
         (1660.190945, 2141.125), (1660.190945, 2439.165), (380.054348, 2439.165),
         (380.054348, 1713.915), (1372.189243, 1713.915)]
INNER = [(1371.12, 1241.84), (1656., 1241.84), (1656., 2448.08),
         (385.92, 2448.08), (385.92, 1713.92), (1371.12, 1713.92)]
OUTER = [(1365.36, 1236.08), (1661.76, 1236.08), (1661.76, 2453.6),
         (380.16, 2453.6), (380.16, 1708.16), (1365.36, 1708.16)]


def lines(ring):
    return list(zip(ring, ring[1:] + ring[:1]))


def refine(rings, segments, *, policy="inner_parapet", raster_segments=None, box=(0, 0, 1000, 1000),
           cleanup="none", prepared=False):
    image = Image.new('RGB', (3000, 3000), 'white')
    draw = ImageDraw.Draw(image)
    for a, b in segments if raster_segments is None else raster_segments:
        draw.line([a, b], fill='black', width=1)
    stream = BytesIO()
    image.save(stream, format='PNG')
    png = stream.getvalue()
    crop = g.prepare_outline_crop(png, box)
    polygons = [[{'x': (x - crop.crop['x']) * 1000 / crop.crop['width'],
                  'y': (y - crop.crop['y']) * 1000 / crop.crop['height']} for x, y in ring] for ring in rings]
    vectors = [{'start': {'x': a[0], 'y': a[1]}, 'end': {'x': b[0], 'y': b[1]}} for a, b in segments]
    return g.refine_outline_polygons(png, box, crop.crop, polygons, vectors, cleanup=cleanup,
                                    boundary_policy=policy, source=crop.source if prepared else None)


class BoundaryContinuityTests(unittest.TestCase):
    def test_captured_face_switch_is_repaired_with_original_and_evidence_preserved(self):
        segments = lines(INNER) + lines(OUTER) + [((1640.4, 1251.92), (1640.4, 2149.04)),
                                                 ((1646.16, 1246.16), (1646.16, 2154.8))]
        for cleanup in ('none', 'shapely'):
            with self.subTest(cleanup=cleanup):
                result = refine([MODEL], segments, cleanup=cleanup, prepared=True)
                proposal = result['proposals'][0]
                self.assertEqual(len(proposal['points']), 6)
                self.assertEqual(len(proposal['proposed_points']), 8)
                self.assertEqual(result['status'], 'needs_review')
                self.assertIn('boundary_steps_straightened', proposal['warnings'])
                self.assertNotIn('corner_steps_straightened', proposal['warnings'])
                self.assertEqual([e['index'] for e in proposal['edges']], list(range(6)))
                right = [(i, a, proposal['points'][(i + 1) % 6]) for i, a in enumerate(proposal['points'])
                         if abs(a['x'] - 1656) < .01 and abs(proposal['points'][(i + 1) % 6]['x'] - 1656) < .01]
                self.assertEqual(len(right), 1)
                edge = proposal['edges'][right[0][0]]
                self.assertEqual(edge['source'], 'vector')
                self.assertGreater(edge['support'], .98)
                self.assertFalse(edge['ambiguous'])

    def test_policy_selects_supported_face_and_roof_deck_keeps_ambiguity(self):
        for policy, expected_x in [('inner_parapet', 1656.), ('outer_roof', 1661.76), ('roof_deck', None)]:
            with self.subTest(policy=policy):
                proposal = refine([MODEL], lines(INNER) + lines(OUTER), policy=policy)['proposals'][0]
                if expected_x is None:
                    self.assertEqual(len(proposal['points']), 8)
                    self.assertIn('boundary_continuity_ambiguous', proposal['warnings'])
                    self.assertTrue(all(proposal['edges'][i]['ambiguous'] for i in (1, 2, 3)))
                else:
                    self.assertEqual(len(proposal['points']), 6)
                    self.assertAlmostEqual(proposal['points'][1]['x'], expected_x)
                    self.assertAlmostEqual(proposal['points'][2]['x'], expected_x)

    def test_unambiguous_single_line_works_for_all_policies(self):
        for policy in ('inner_parapet', 'outer_roof', 'roof_deck'):
            with self.subTest(policy=policy):
                self.assertEqual(len(refine([MODEL], lines(INNER), policy=policy)['proposals'][0]['points']), 6)

    def test_real_shallow_step_is_preserved_even_with_a_nearby_continuous_line(self):
        proposal = refine([MODEL], lines(MODEL) + lines(INNER))['proposals'][0]
        self.assertEqual(len(proposal['points']), 8)
        self.assertNotIn('boundary_steps_straightened', proposal['warnings'])
        self.assertNotIn('boundary_continuity_ambiguous', proposal['warnings'])

    def test_raster_connector_also_protects_a_genuine_step(self):
        proposal = refine([MODEL], lines(INNER), raster_segments=lines(INNER) + lines(MODEL))['proposals'][0]
        self.assertEqual(len(proposal['points']), 8)
        self.assertNotIn('boundary_steps_straightened', proposal['warnings'])

    def test_raster_only_or_unclear_side_evidence_is_reviewed_without_merging(self):
        for segments, pixels in [([], lines(INNER)), (lines(INNER) + lines(OUTER), [])]:
            with self.subTest(vector_count=len(segments)):
                proposal = refine([MODEL], segments, raster_segments=pixels)['proposals'][0]
                self.assertEqual(len(proposal['points']), 8)
                self.assertIn('boundary_continuity_ambiguous', proposal['warnings'])
                self.assertTrue(all(proposal['edges'][i]['ambiguous'] for i in (1, 2, 3)))

    def test_a_partial_line_or_unconnected_dimension_does_not_repair_the_side(self):
        partial = lines(INNER)
        partial[1] = (INNER[1], (1656, 2200))  # Most of the total length, little of the lower run.
        for segments in (partial, [lines(INNER)[1]]):
            with self.subTest(segments=segments):
                proposal = refine([MODEL], segments)['proposals'][0]
                self.assertEqual(len(proposal['points']), 8)
                self.assertIn('boundary_continuity_ambiguous', proposal['warnings'])

    def test_gap_at_the_junction_is_not_hidden_by_high_total_line_coverage(self):
        segments = lines(INNER)
        segments[1:2] = [(INNER[1], (1656, 2120)), ((1656, 2160), INNER[2])]
        proposal = refine([MODEL], segments)['proposals'][0]
        self.assertEqual(len(proposal['points']), 8)
        self.assertIn('boundary_continuity_ambiguous', proposal['warnings'])

    def test_fragmented_continuous_line_and_prepared_raster_match_the_full_page(self):
        segments = lines(INNER)
        segments[1:2] = [(INNER[1], (1656, 1800)), ((1656, 1800), (1656, 2141)),
                         ((1656, 2141), INNER[2])]
        result = refine([MODEL], segments)
        self.assertEqual(len(result['proposals'][0]['points']), 6)
        self.assertEqual(result, refine([MODEL], segments, prepared=True))

    def test_more_than_two_supported_faces_require_review(self):
        middle = [(x + 3, y) for x, y in INNER]
        proposal = refine([MODEL], lines(INNER) + lines(OUTER) + lines(middle))['proposals'][0]
        self.assertEqual(len(proposal['points']), 8)
        self.assertIn('boundary_continuity_ambiguous', proposal['warnings'])

    def test_large_step_or_excessive_scope_change_is_never_straightened(self):
        wide = [p if i not in (1, 2) else (p[0] - 30, p[1]) for i, p in enumerate(MODEL)]
        proposal = refine([wide], lines(INNER))['proposals'][0]
        self.assertEqual(len(proposal['points']), 8)
        self.assertNotIn('boundary_steps_straightened', proposal['warnings'])
        narrow = [(1000, 500), (1035, 500), (1035, 900), (1055, 900), (1055, 1200), (1000, 1200)]
        rectangle = [(1000, 500), (1055, 500), (1055, 1200), (1000, 1200)]
        proposal = refine([narrow], lines(rectangle))['proposals'][0]
        self.assertEqual(len(proposal['points']), 6)
        self.assertNotIn('boundary_steps_straightened', proposal['warnings'])

    def test_repair_and_later_fitting_share_one_area_change_allowance(self):
        # Repair alone adds 3.6%; subsequent left-edge fitting would make the total exceed 4%.
        model = [(104, 100), (383, 100), (383, 500), (403, 500), (403, 700), (104, 700)]
        rectangle = [(100, 100), (400, 100), (400, 700), (100, 700)]
        proposal = refine([model], lines(rectangle))['proposals'][0]
        self.assertEqual(len(proposal['points']), 6)
        self.assertIn('fitting_rejected', proposal['warnings'])
        self.assertIn('boundary_continuity_ambiguous', proposal['warnings'])
        self.assertNotIn('boundary_steps_straightened', proposal['warnings'])
        self.assertTrue(all(edge['ambiguous'] for edge in proposal['edges']))

    def test_winding_rotation_and_ring_start_do_not_change_the_repair(self):
        angle = math.radians(23)
        transform = lambda p: (1500 + (p[0]-1500)*math.cos(angle) - (p[1]-1500)*math.sin(angle),
                               1500 + (p[0]-1500)*math.sin(angle) + (p[1]-1500)*math.cos(angle))
        for reverse in (False, True):
            # Starts inside the step, exercising cyclic removal across the closing edge.
            ring = MODEL[3:] + MODEL[:3]
            ring = list(reversed(ring)) if reverse else ring
            ring = [transform(p) for p in ring]
            segments = [(transform(a), transform(b)) for a, b in lines(INNER) + lines(OUTER)]
            proposal = refine([ring], segments)['proposals'][0]
            points = [(p['x'], p['y']) for p in proposal['points']]
            self.assertEqual(len(points), 6)
            self.assertGreater(g._area(points) * g._area(ring), 0)
            self.assertTrue(g._valid_ring(points))
            self.assertIn('boundary_steps_straightened', proposal['warnings'])

    def test_repair_cannot_expand_past_roi_or_into_another_component(self):
        # The new boundary would contain a previously separate small component in the step strip.
        island = [(1644, 1600), (1650, 1600), (1650, 1660), (1644, 1660)]
        result = refine([MODEL, island], lines(INNER))
        self.assertEqual(len(result['proposals'][0]['points']), 8)
        self.assertIn('component_conflict', result['warnings'])
        self.assertNotIn('boundary_steps_straightened', result['warnings'])
        # Only the outer candidate is drawn, but it lies outside the permitted region.
        result = refine([MODEL], lines(OUTER), box=(0, 0, 1000, 1661 / 3))
        self.assertEqual(len(result['proposals'][0]['points']), 8)
        self.assertNotIn('boundary_steps_straightened', result['warnings'])

    def test_invalid_policy_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'invalid_boundary_policy'):
            refine([MODEL], lines(INNER), policy='guess')
