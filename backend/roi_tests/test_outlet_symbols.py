from io import BytesIO
import unittest

from PIL import Image, ImageDraw

from backend.app.outlet_models import OutletAnnotation, OutletScope
from backend.app.outlet_symbols import refine_outlet_symbols


def rectangle(left, top, right, bottom):
    return [{"x": left, "y": top}, {"x": right, "y": top},
            {"x": right, "y": bottom}, {"x": left, "y": bottom}]


def scope(holes=None):
    return OutletScope(roi_id="roof", outline_id="outline", polygons=[{
        "outer": rectangle(40, 20, 220, 160), "holes": holes or []}])


def candidate(anchor=(100, 160), box=(88, 145, 112, 161), **changes):
    left, top, right, bottom = box
    normalized = [top * 5, left * 4, bottom * 5, right * 4]
    return OutletAnnotation(id="inlet", page_id="page", label="RWP", subtype="parapet_outlet",
        box_2d=normalized, proposed_box_2d=normalized,
        anchor=dict(x=anchor[0], y=anchor[1]), proposed_anchor=dict(x=anchor[0], y=anchor[1]),
        roi_id="roof", outline_id="outline", evidence="Dashed roof-side inlet with an external downpipe.", **changes)


def png(draw):
    image = Image.new("RGB", (250, 200), "white")
    draw(ImageDraw.Draw(image))
    stream = BytesIO()
    image.save(stream, "PNG")
    return stream.getvalue()


def u_box(draw, left=88, top=145, right=112, bottom=159, colour="#00bfff"):
    for x in range(left, right + 1, 6):
        draw.line((x, top, min(x + 3, right), top), fill=colour)
    for y in range(top, bottom + 1, 6):
        draw.line((left, y, left, min(y + 3, bottom)), fill=colour)
        draw.line((right, y, right, min(y + 3, bottom)), fill=colour)


class OutletSymbolTests(unittest.TestCase):
    def test_boundary_anchor_refined_to_roof_side_box_not_external_downpipe(self):
        def drawing(draw):
            u_box(draw)
            draw.line((40, 160, 220, 160), fill="black")
            draw.ellipse((97, 176, 103, 182), fill="#00bfff")
        item = candidate()
        proposed_box = item.proposed_box_2d
        refine_outlet_symbols(png(drawing), [item], scope())
        self.assertAlmostEqual(item.anchor.x, 100.5)
        self.assertAlmostEqual(item.anchor.y, 152.5)
        self.assertEqual((item.proposed_anchor.x, item.proposed_anchor.y), (100, 160))
        self.assertEqual(item.proposed_box_2d, proposed_box)
        self.assertEqual(item.review_status, "suggested")

    def test_small_outside_error_can_be_corrected_only_by_visible_inlet(self):
        item = candidate(anchor=(100, 161))
        refine_outlet_symbols(png(u_box), [item], scope())
        self.assertLess(item.anchor.y, 160)

    def test_uncertain_or_unsupported_symbols_keep_original_coordinates(self):
        drawings = {
            "empty": lambda draw: None,
            "black_box": lambda draw: u_box(draw, colour="black"),
            "external_dot": lambda draw: draw.ellipse((94, 149, 106, 161), fill="#00bfff"),
            "circle": lambda draw: draw.ellipse((88, 145, 112, 159), outline="#00bfff"),
            "arrow": lambda draw: draw.line([(100, 145), (100, 159), (96, 153), (104, 153), (100, 159)], fill="#00bfff"),
            "clipped_box": lambda draw: u_box(draw, left=70, right=130),
        }
        for name, drawing in drawings.items():
            with self.subTest(name=name):
                item = candidate()
                refine_outlet_symbols(png(drawing), [item], scope())
                self.assertEqual(item.anchor, item.proposed_anchor, name)

    def test_two_plausible_boxes_are_not_resolved_by_scope_or_nearest_distance(self):
        item = candidate(anchor=(100, 160), box=(84, 143, 116, 162))
        def drawing(draw):
            u_box(draw, left=76, right=92)
            u_box(draw, left=108, right=124)
        refine_outlet_symbols(png(drawing), [item], scope())
        self.assertEqual(item.anchor, item.proposed_anchor)

    def test_holes_outside_scopes_and_other_outlet_types_are_not_rescued(self):
        for assigned, subtype, anchor in [
            (scope([rectangle(85, 140, 115, 165)]), "parapet_outlet", (100, 160)),
            (OutletScope(roi_id="roof", outline_id="outline", polygons=[{
                "outer": rectangle(40, 20, 220, 140)}]), "parapet_outlet", (100, 160)),
            (scope(), "internal_outlet", (100, 160)),
        ]:
            with self.subTest(subtype=subtype, assigned=assigned):
                item = candidate(anchor=anchor)
                item.subtype = subtype
                refine_outlet_symbols(png(u_box), [item], assigned)
                self.assertEqual(item.anchor, item.proposed_anchor)

    def test_fitting_uses_original_pixels_on_transparent_pages(self):
        image = Image.new("RGBA", (250, 200), (0, 0, 0, 0))
        u_box(ImageDraw.Draw(image))
        stream = BytesIO()
        image.save(stream, "PNG")
        item = candidate()
        refine_outlet_symbols(stream.getvalue(), [item], scope())
        self.assertAlmostEqual(item.anchor.y, 152.5)
