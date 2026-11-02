"""Offline replay and local-variable diagnostics; never calls the provider."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import outline_geometry as g
from backend.roi_reference import outline_benchmark as b

case = next(c for c in b.load_outline_manifest().cases if c.id == "tp17221-roof")
png = b.page_png(case)
width, height = g._page_size(png)
vectors = b.roi_vectors(b.page_vectors(case), width, height, case.roi_box)

def trace(frame, event, arg):
    if frame.f_code is g._fit_ring.__code__ and event == "line":
        state = frame.f_locals
        if "ratio" in state and state["fitted"] != state["points"]:
            points, fitted = state["points"], state["fitted"]
            shifts = [g._distance(a, z) for a, z in zip(points, fitted)]
            if max(shifts) > state["max_shift"] * 1.6:
                print(json.dumps({"ratio": state["ratio"], "valid": g._valid_ring(fitted),
                    "corners": [{"index": i, "from": a, "to": z, "distance": shift,
                                 "previous": points[i - 1], "next": points[(i + 1) % len(points)],
                                 "edges": [state["evidence"][i-1], state["evidence"][i]]}
                                for i, (a, z, shift) in enumerate(zip(points, fitted, shifts)) if shift > 19.2]}))
                return None
    return trace

for record in b.load_captures(case.id):
    if record["outcome"] != "parsed" or record["roi_too_tight"]:
        continue
    print(record["captured_at"])
    sys.settrace(trace)
    result = g.refine_outline_polygons(png, case.roi_box, record["crop"], record["polygons"], vectors,
                                      cleanup="shapely", boundary_policy=case.boundary_policy)
    sys.settrace(None)
    print(json.dumps({"warnings": result["warnings"], "points": result["proposals"][0]["points"]}))
