"""Conservative localisation of coloured parapet inlet boxes in original pixels.

The model identifies the outlet. This pass can only refine an already proposed
blue/cyan rectangular inlet, including a three-sided box open to the parapet.
It does not snap points to the roof or substitute external downpipe circles.
Unsupported, clipped or ambiguous symbols retain their model coordinates.
"""
from io import BytesIO
import math

from PIL import Image, ImageFilter

from .outlet_geometry import scope_location
from .outline_models import OutlinePoint


def _components(mask):
    """Small local masks only; closing dash gaps must not create source evidence."""
    pixels = mask.load()
    remaining = {(x, y) for y in range(mask.height) for x in range(mask.width) if pixels[x, y]}
    while remaining:
        seed = remaining.pop()
        component, pending = [seed], [seed]
        while pending:
            x, y = pending.pop()
            for neighbour in ((x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)):
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    component.append(neighbour)
                    pending.append(neighbour)
        yield component


def _box_centre(image, candidate, scope):
    height, width = image.height, image.width
    top, left, bottom, right = candidate.box_2d
    left, right, top, bottom = left * width / 1000, right * width / 1000, top * height / 1000, bottom * height / 1000
    short, long = min(right - left, bottom - top), max(right - left, bottom - top)
    # Avoid broad detections containing labels, whole parapets or multiple symbols.
    if short < 4 or long > 120 or long / short > 4:
        return None
    padding = max(6, min(20, short * .75))
    x0, y0 = max(0, math.floor(left - padding)), max(0, math.floor(top - padding))
    x1, y1 = min(width, math.ceil(right + padding)), min(height, math.ceil(bottom + padding))
    rgba = image.crop((x0, y0, x1, y1)).convert("RGBA")
    rgb = Image.new("RGBA", rgba.size, "white")
    rgb.alpha_composite(rgba)
    mask = Image.new("L", rgb.size)
    # Deliberately opt in only for this common CAD inlet colour family. Dark
    # monochrome linework and other symbol styles fall back to model/manual review.
    rgb_pixels = rgb.load()
    mask.putdata([255 if b > 140 and g > r + 35 and b > r + 60 else 0
                  for y in range(rgb.height) for x in range(rgb.width) for r, g, b, _ in [rgb_pixels[x, y]]])
    ink = mask.load()
    gap = max(1, min(4, round(short / 6)))
    matches = []
    for component in _components(mask.filter(ImageFilter.MaxFilter(2 * gap + 1))):
        points = [(x, y) for x, y in component if ink[x, y]]
        if len(points) < 12:
            continue
        xs, ys = [p[0] for p in points], [p[1] for p in points]
        a, b, c, d = min(xs), min(ys), max(xs), max(ys)
        w, h = c - a + 1, d - b + 1
        if a == 0 or b == 0 or c == mask.width - 1 or d == mask.height - 1:
            continue  # Do not centre a symbol cut by our search window or page.
        if min(w, h) < 6 or max(w, h) / min(w, h) > 3.5:
            continue
        if not .45 <= w / (right - left) <= 2.2 or not .45 <= h / (bottom - top) <= 2.2:
            continue
        band = max(1, min(3, round(min(w, h) * .12)))
        sides = [len({y for x, y in points if x <= a + band}) / h,
                 len({y for x, y in points if x >= c - band}) / h,
                 len({x for x, y in points if y <= b + band}) / w,
                 len({x for x, y in points if y >= d - band}) / w]
        border = sum(x <= a + band or x >= c - band or y <= b + band or y >= d - band for x, y in points)
        corner_band = max(1, round(min(w, h) * .08))
        corners = sum(any(abs(x - cx) <= corner_band and abs(y - cy) <= corner_band for x, y in points)
                      for cx, cy in ((a, b), (c, b), (c, d), (a, d)))
        # A box or U has three well-supported sides and almost no interior ink.
        # Text, arrows, solid downpipe dots and circles fail these checks.
        if sum(coverage >= .55 for coverage in sides) < 3 or border / len(points) < .9 or corners < 3:
            continue
        centre = OutlinePoint(x=x0 + (a + c + 1) / 2, y=y0 + (b + d + 1) / 2)
        overlap = max(0, min(right, x0 + c + 1) - max(left, x0 + a)) * max(0, min(bottom, y0 + d + 1) - max(top, y0 + b))
        if overlap < .35 * min(w * h, (right - left) * (bottom - top)):
            continue
        if math.hypot(centre.x - candidate.anchor.x, centre.y - candidate.anchor.y) > min(24, max(w, h) * .65):
            continue
        # Count all plausible symbols before checking scope: the scope must not
        # choose between two competing symbols, or rescue an excluded opening.
        matches.append((centre, (b + y0, a + x0, d + y0 + 1, c + x0 + 1)))
    if len(matches) != 1 or scope_location(candidate.anchor, scope) == "opening":
        return None
    centre, bounds = matches[0]
    if scope_location(centre, scope) != "inside":
        return None
    return centre, (bounds[0] / height * 1000, bounds[1] / width * 1000,
                    bounds[2] / height * 1000, bounds[3] / width * 1000)


def refine_outlet_symbols(original, candidates, scope):
    """Keep the original proposal for reconciliation; every result still needs acceptance."""
    with Image.open(BytesIO(original)) as image:
        for candidate in candidates:
            if candidate.subtype not in {"parapet_outlet", "scupper"}:
                continue
            fitted = _box_centre(image, candidate, scope)
            if fitted is not None:
                candidate.anchor, candidate.box_2d = fitted
    return candidates
