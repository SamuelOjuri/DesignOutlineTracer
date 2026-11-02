"""Compare local-corner fallback with v4 on existing captures, entirely offline."""
from io import BytesIO
import inspect
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from PIL import Image, ImageDraw
from backend.app import outline_geometry as g
from backend.app.errors import RoiError
from backend.roi_reference import outline_benchmark as b
from backend.roi_reference.outline_metrics import score_outline

source = inspect.getsource(g._fit_ring)
start = source.index("    original_lines =")
end = source.index("    ratio =", start)
old_intersection = '''    fitted = []
    for index, original in enumerate(points):
        (n1, c1), (n2, c2) = lines[index - 1], lines[index]
        det = n1[0] * n2[1] - n1[1] * n2[0]
        if abs(det) < .05:
            fitted.append(original)
        else:
            fitted.append(((c1 * n2[1] - n1[1] * c2) / det, (n1[0] * c2 - c1 * n2[0]) / det))
'''
namespace = vars(g).copy()
exec(compile(source[:start] + old_intersection + source[end:], "<v4-fit-ring>", "exec"), namespace)
old_fit = namespace["_fit_ring"]
summary = {"cases": 0, "parsed": 0, "unchanged": 0, "changed": [], "failures": []}
example = None
for case in b.load_outline_manifest().cases:
    summary["cases"] += 1
    png = b.page_png(case)
    width, height = g._page_size(png)
    vectors = b.roi_vectors(b.page_vectors(case), width, height, case.roi_box)
    for record in b.load_captures(case.id):
        if record["outcome"] != "parsed" or record["roi_too_tight"]:
            continue
        summary["parsed"] += 1
        outputs = []
        for function in (old_fit, g._fit_ring):
            try:
                with patch.object(g, "_fit_ring", function):
                    outputs.append(g.refine_outline_polygons(png, case.roi_box, record["crop"], record["polygons"],
                        vectors, cleanup="shapely", boundary_policy=case.boundary_policy))
            except RoiError as error:
                outputs.append({"error": error.code})
        before, after = outputs
        if before == after:
            summary["unchanged"] += 1
            continue
        if "error" in after or not after.get("proposals"):
            summary["failures"].append({"case": case.id, "at": record["captured_at"], "after": after})
            continue
        rings = lambda result: [[(p["x"], p["y"]) for p in item["points"]] for item in result["proposals"]]
        metrics = [score_outline(rings(result), case.reference.polygons, step=4).as_dict() for result in outputs]
        summary["changed"].append({"case": case.id, "at": record["captured_at"],
            "before_warnings": before["warnings"], "after_warnings": after["warnings"],
            "before_iou": metrics[0]["iou"], "after_iou": metrics[1]["iou"],
            "before_boundary_distance": metrics[0]["mean_distance"], "after_boundary_distance": metrics[1]["mean_distance"]})
        if case.id == "tp17221-roof":
            example = png, before, after
Path("tmp/outline-local-fit-verification.json").write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
if example:
    png, before, after = example
    raster = Image.open(BytesIO(png)).convert("RGB")
    left, top, right, bottom = 1040, 2545, 1850, 2690
    scale, heading = 2, 30
    panel_width, panel_height = (right-left)*scale, (bottom-top)*scale + heading
    figure = Image.new("RGB", (panel_width, panel_height*2), "white")
    for index, (result, label) in enumerate(zip((before, after), ("Before: bottom edge retained above the drawn boundary", "After: bottom edge aligned with the continuous inner boundary"))):
        panel = raster.crop((left, top, right, bottom)).resize((panel_width, panel_height-heading))
        ink = ImageDraw.Draw(panel)
        for proposal in result["proposals"]:
            ring = proposal["points"] + proposal["points"][:1]
            ink.line([((p["x"]-left)*scale, (p["y"]-top)*scale) for p in ring], fill="#2563eb", width=2)
        figure.paste(panel, (0, index*panel_height+heading))
        ImageDraw.Draw(figure).text((10, index*panel_height+8), label, fill="black")
    figure.save("tmp/pdfs/tp17221-bottom-local-fit.png")
