"""Read-only assessment of the supplied TP17202 plan and validation PDF."""
from collections import Counter
import json
from pathlib import Path
import shutil
import subprocess
import sys
from io import BytesIO
import math

import fitz

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(r"C:\Users\SamuelOjuri\OneDrive - Tapered Plus\Documents\Samsdocs\Roof Plan Docs\Example 1 - TP17202")
OUT = ROOT / "tmp/pdfs/tp17202-assessment"
sys.path.insert(0, str(ROOT))

# Read directly from the live page's SVG in Chrome's Elements inspector.
LIVE = [(561.6059007866738, 1085.5017056915904), (562.3199999999999, 909.1192),
        (641.28, 909.8392), (641.28, 916.0792), (651.2295145631069, 916.0792),
        (649.4564396895832, 1053.049233979697), (644.1323905699936, 1053.4790844869474),
        (645.2012655267313, 1086.003422456249)]
LIVE_ROI = [530, 228, 654, 279]


def inspect():
    OUT.mkdir(parents=True, exist_ok=True)
    summary = {}
    for kind in ("input", "outline"):
        path = SOURCE / f"TP17202_25.01_{kind}.pdf"
        doc = fitz.open(path)
        page = doc[0]
        drawings = page.get_drawings()
        colored = [d for d in drawings if any(c is not None and max(c)-min(c) > .08
                                              for c in (d.get("color"), d.get("fill")))]
        summary[kind] = {
            "pages": len(doc), "rect": tuple(page.rect),
            "drawing_count": len(drawings),
            "colors": dict(Counter(str(d.get("color")) for d in drawings)),
            "colored_shapes": [{"seqno": d["seqno"], "rect": tuple(d["rect"]),
                                "stroke": d.get("color"), "fill": d.get("fill"),
                                "width": d.get("width"), "items": repr(d["items"])} for d in colored],
            "images": [{"rect": tuple(info["bbox"]), "transform": info["transform"],
                        "size": (info["width"], info["height"])} for info in page.get_image_info()],
            "annotations": [{"type": a.type, "colors": a.colors, "rect": tuple(a.rect),
                             "vertices": a.vertices} for a in page.annots()],
            "text": page.get_text(),
        }
        prefix = OUT / kind
        renderer = shutil.which("pdftoppm")
        if renderer:
            subprocess.run([renderer, "-f", "1", "-singlefile", "-r", "96", "-png", str(path), str(prefix)], check=True)
        else:
            page.get_pixmap(matrix=fitz.Matrix(4/3, 4/3)).save(str(prefix)+".png")
        page.get_pixmap(matrix=fitz.Matrix(4, 4), clip=fitz.Rect(260, 260, 350, 560)).save(str(OUT / f"{kind}-scope-detail.png"))
        print(kind, json.dumps({k: v for k, v in summary[kind].items() if k not in {"colored_shapes", "text"}}, default=str))
        print("colored", len(colored))
        print("text", page.get_text()[:3500])
    (OUT / "pdf-inspection.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")


def replay():
    from PIL import Image, ImageDraw, ImageFont
    from shapely.geometry import Polygon
    from backend.app import outline_geometry as g
    from backend.app.outline_cleanup import clean_ring
    from backend.roi_reference import outline_benchmark as b
    from backend.roi_reference.outline_metrics import score_outline

    OUT.mkdir(parents=True, exist_ok=True)
    manifest = b.load_outline_manifest()
    case = next(c for c in manifest.cases if c.id == "tp17202-south")
    png = b.page_png(case)
    prepared = g.prepare_outline_crop(png, LIVE_ROI)
    bounds = g._bounds(LIVE_ROI, prepared.source_width, prepared.source_height)
    snap = g._max_shift(bounds)
    vector_json = b.roi_vectors(b.page_vectors(case), prepared.source_width, prepared.source_height, LIVE_ROI)
    vectors = [((s["start"]["x"], s["start"]["y"]), (s["end"]["x"], s["end"]["y"])) for s in vector_json]
    raster = (prepared.source.gray.load(), prepared.source.origin, prepared.source.gray.width, prepared.source.gray.height)
    reference = case.reference.polygons[0]
    summary = {
        "algorithm": g.ALGORITHM_VERSION, "live_points": LIVE, "live_roi": LIVE_ROI,
        "snap_px": snap, "validation_dimensions_mm": [1569, 3136],
        "comparison_reference": reference,
        "reference_note": "Existing dimension-registered draft on the input PDF. The supplied validation PDF is a separate 1:50 layout and has four-sided rectangles, not a page-aligned mask.",
        "live_metrics_against_registered_draft": score_outline([LIVE], [reference], step=1).as_dict(),
        "live_area_px": Polygon(LIVE).area,
        "reference_area_px": Polygon(reference).area,
        "live_cleaned": clean_ring(LIVE, bounds=bounds, snap=snap),
        "boundary_chains": g._boundary_side_chains(LIVE, snap),
        "edges": [], "captured_replays": [],
    }
    for index, (a, z) in enumerate(zip(LIVE, LIVE[1:] + LIVE[:1])):
        options = g._vector_candidates(a, z, vectors, .5)
        summary["edges"].append({"index": index, "length": math.dist(a, z),
            "continuous_source": g._continuous_vector_span(a, z, vectors),
            "nearby_source_support": max((o["support"] for o in options), default=0.)})
    for record in b.load_captures(case.id):
        if record["outcome"] != "parsed" or record["roi_too_tight"]:
            continue
        crop = record["crop"]
        raw = [(crop["x"]+p["x"]*crop["width"]/1000, crop["y"]+p["y"]*crop["height"]/1000)
               for p in record["polygons"][0]]
        result = g.refine_outline_polygons(png, LIVE_ROI, crop, record["polygons"], vector_json,
                                           source=prepared.source, cleanup="shapely", boundary_policy="inner_parapet")
        fitted = [(p["x"], p["y"]) for p in result["proposals"][0]["points"]]
        summary["captured_replays"].append({"at": record["captured_at"], "raw": raw,
            "cleaned": clean_ring(raw, bounds=bounds, snap=snap), "result": result,
            "live_hausdorff_px": Polygon(fitted).boundary.hausdorff_distance(Polygon(LIVE).boundary)})

    # The validation PDF is a separate sheet. Read its finite perimeter edges independently.
    validation = fitz.open(SOURCE / "TP17202_25.01_outline.pdf")
    summary["validation_perimeter_lines"] = [
        {"rect": tuple(d["rect"]), "items": repr(d["items"])}
        for d in validation[0].get_drawings()
        if d.get("color") == (0., 0., 0.) and len(d["items"]) <= 4
        and 580 < d["rect"].x0 < 676 and 275 < d["rect"].y0 < 710
        and (d["rect"].width > 70 or d["rect"].height > 150)]
    (OUT / "geometry-assessment.json").write_text(json.dumps(summary, indent=2, default=list), encoding="utf-8")
    print(json.dumps({k:v for k,v in summary.items() if k not in {"captured_replays", "validation_perimeter_lines"}}, indent=2, default=list))
    print("replays", json.dumps([{k:v for k,v in r.items() if k not in {"raw", "cleaned", "result"}}
                                | {"raw_vertices":len(r["raw"]), "final_vertices":len(r["result"]["proposals"][0]["points"]),
                                   "warnings":r["result"]["warnings"]} for r in summary["captured_replays"]], indent=2))
    print("validation_lines", json.dumps(summary["validation_perimeter_lines"]))

    # A static analysis figure, using exact live vertices and dimension-registered reference.
    source = Image.open(BytesIO(png)).convert("RGB")
    region = (536, 888, 675, 1105)
    scale, head, gap = 3, 75, 28
    panel_width, panel_height = (region[2]-region[0])*scale, (region[3]-region[1])*scale
    figure = Image.new("RGB", (panel_width*3+gap*4, panel_height+head+80), "#f7f9fc")
    draw = ImageDraw.Draw(figure)
    font = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 18)
    small = ImageFont.truetype("C:/Windows/Fonts/arial.ttf", 16)
    for index, title in enumerate(("Input drawing", "Generated: 8 vertices", "Comparison with 4-sided reference")):
        x0 = gap+(panel_width+gap)*index
        draw.text((x0, 25), title, font=font, fill="#18283b")
        panel = source.crop(region).resize((panel_width,panel_height))
        ink = ImageDraw.Draw(panel)
        if index == 2:
            ink.line([((p[0]-region[0])*scale,(p[1]-region[1])*scale) for p in reference+reference[:1]], fill="#c2410c", width=4)
        if index >= 1:
            ink.line([((p[0]-region[0])*scale,(p[1]-region[1])*scale) for p in LIVE+LIVE[:1]], fill="#2563eb", width=3)
            for i in (2,3,5,6):
                px, py = (LIVE[i][0]-region[0])*scale, (LIVE[i][1]-region[1])*scale
                ink.ellipse((px-6,py-6,px+6,py+6), outline="#b91c1c", width=2)
        figure.paste(panel,(x0,head))
    draw.text((gap,head+panel_height+18), "Blue: exact current app outline. Orange: dimension-registered reference. Red circles: extra right-side returns.", font=small, fill="#18283b")
    draw.text((gap,head+panel_height+42), "Reference registration is approximate; the supplied validation PDF independently confirms the rectangular shape and dimensions.", font=small, fill="#526377")
    figure.save(OUT/"comparison.png")


if __name__ == "__main__":
    replay() if "replay" in sys.argv else inspect()
