from io import BytesIO
import random
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw

from backend.app.models import DetectionVector, PenetrationScope, Proposal
from backend.app.outline_geometry import OutlineCropSource, prepare_outline_crop
from backend.app.penetration_geometry import (VectorIndex, annotation_from_proposal,
                                             annotations_from_proposals, refine_ring)


def image_bytes(mode="RGB", size=(520, 420)):
    image = Image.new(mode, size, (255, 255, 255, 0) if mode == "RGBA" else "white")
    draw = ImageDraw.Draw(image)
    draw.polygon([(10, 30), (430, 80), (310, 350), (90, 290)], fill=(31, 97, 181, 117)
                 if mode == "RGBA" else "gray", outline="black")
    draw.line([(0, 70), (510, 70), (490, 400)], fill="black", width=2)
    if mode == "RGBA":
        draw.rectangle((150, 75, 330, 210), fill=(201, 23, 97, 61))
    output = BytesIO()
    image.save(output, format="PNG")
    image.close()
    return output.getvalue()


def vectors(ring):
    return [DetectionVector(start={"x": a[0], "y": a[1]}, end={"x": b[0], "y": b[1]})
            for a, b in zip(ring, ring[1:] + ring[:1])]


class PenetrationPerformanceGeometryTests(unittest.TestCase):
    def test_reused_decode_preserves_crop_png_and_fitting_pixels(self):
        for mode in ("RGB", "RGBA"):
            with self.subTest(mode=mode):
                data = image_bytes(mode, (2400, 1100))
                with patch("backend.app.outline_geometry.Image.open", wraps=Image.open) as opened:
                    source = OutlineCropSource(data)
                    try:
                        prepared = [source.prepare(box) for box in (
                            [0, 0, 1000, 1000], [100, 200, 700, 800], [0, 900, 200, 1000])]
                    finally:
                        source.close()
                    self.assertEqual(opened.call_count, 1)
                for box, actual in zip(([0, 0, 1000, 1000], [100, 200, 700, 800],
                                        [0, 900, 200, 1000]), prepared):
                    expected = prepare_outline_crop(data, box)
                    self.assertEqual(actual.crop, expected.crop)
                    self.assertEqual(actual.png, expected.png)
                    self.assertEqual(actual.source.origin, expected.source.origin)
                    self.assertEqual(actual.source.page_size, expected.source.page_size)
                    self.assertEqual(actual.source.gray.tobytes(), expected.source.gray.tobytes())
                    actual.source.gray.close()
                    expected.source.gray.close()

    def test_index_preserves_original_bbox_selection_order_and_touching_edges(self):
        generator = random.Random(173)
        records = [DetectionVector(start={"x": generator.uniform(0, 1000), "y": generator.uniform(0, 1000)},
                                   end={"x": generator.uniform(0, 1000), "y": generator.uniform(0, 1000)})
                   for _ in range(500)]
        records += [DetectionVector(start={"x": 100, "y": 100}, end={"x": 100, "y": 100}),
                    DetectionVector(start={"x": 100, "y": 500}, end={"x": 100, "y": 100})]
        index = VectorIndex(records)
        for left, top, right, bottom in [(100, 100, 200, 200), (0, 0, 1000, 1000), (1200, 1200, 1300, 1300)]:
            expected = [((record.start.x, record.start.y), (record.end.x, record.end.y)) for record in records
                        if max(record.start.x, record.end.x) >= left
                        and min(record.start.x, record.end.x) <= right
                        and max(record.start.y, record.end.y) >= top
                        and min(record.start.y, record.end.y) <= bottom]
            self.assertEqual(index.query((left, top, right, bottom)), expected)
        self.assertEqual(VectorIndex([]).query((0, 0, 1, 1)), [])

    def test_index_does_not_change_rotated_concave_or_unsupported_fits(self):
        for ring in ([(20, 20), (70, 35), (55, 85), (5, 70)],
                     [(20, 20), (60, 30), (50, 60), (40, 50), (30, 55), (15, 40)]):
            proposal = [(x + .3, y + .2) for x, y in ring]
            records = vectors(ring) + vectors([(300, 300), (350, 300), (350, 350), (300, 350)])
            self.assertEqual(refine_ring(proposal, records), refine_ring(proposal, VectorIndex(records)))
            self.assertEqual(refine_ring(proposal, []), refine_ring(proposal, VectorIndex([])))

    def test_index_and_reused_decode_preserve_raster_only_fit(self):
        data = image_bytes()
        legacy = prepare_outline_crop(data, [0, 0, 1000, 1000])
        reused = OutlineCropSource(data)
        try:
            prepared = reused.prepare([0, 0, 1000, 1000])
            proposal = [(11, 31), (431, 81), (311, 351), (91, 291)]
            self.assertEqual(refine_ring(proposal, [], legacy.source),
                             refine_ring(proposal, VectorIndex([]), prepared.source))
        finally:
            reused.close()
            legacy.source.gray.close()
            prepared.source.gray.close()

    def test_batch_fitting_preserves_scope_holes_and_review_metadata(self):
        page = SimpleNamespace(image=SimpleNamespace(width=100, height=100), context=SimpleNamespace(page_id="page"))
        scope = PenetrationScope(roi_id="roof", outline_id="outline", outer=[
            {"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 100}, {"x": 0, "y": 100}],
            holes=[[{"x": 40, "y": 40}, {"x": 60, "y": 40}, {"x": 60, "y": 60}, {"x": 40, "y": 60}]])
        proposals = [Proposal(label="Riser", roi_id="roof", subtype="riser", box_2d=[100, 100, 300, 300],
                              footprint=[{"x": 100, "y": 100}, {"x": 300, "y": 100},
                                         {"x": 300, "y": 300}, {"x": 100, "y": 300}]),
                     Proposal(label="Unknown", roi_id="roof", subtype="unknown", box_2d=[300, 300, 500, 500]),
                     Proposal(label="Inside hole", roi_id="roof", subtype="riser", box_2d=[450, 450, 550, 550])]
        crop = {"x": 0, "y": 0, "width": 100, "height": 100}
        records = vectors([(10, 10), (30, 10), (30, 30), (10, 30)])
        expected = [candidate for position, proposal in enumerate(proposals)
                    if (candidate := annotation_from_proposal(proposal, page, f"candidate{position}", crop,
                                                             scope, records)) is not None]
        actual = annotations_from_proposals(proposals, page, crop, scope, VectorIndex(records))
        self.assertEqual([value.model_dump(exclude={"id"}) for value in actual],
                         [value.model_dump(exclude={"id"}) for value in expected])


if __name__ == "__main__":
    unittest.main()
