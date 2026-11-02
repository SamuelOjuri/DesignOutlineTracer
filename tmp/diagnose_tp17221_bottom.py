"""Read-only, offline diagnosis of TP17221 lower-edge snapping."""
import json
import sys
from hashlib import sha256
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import outline_geometry as g
from backend.roi_reference import outline_benchmark as b

case = next(c for c in b.load_outline_manifest().cases if c.id == "tp17221-roof")
png = b.page_png(case)
width, height = g._page_size(png)
vectors = b.roi_vectors(b.page_vectors(case), width, height, case.roi_box)
segments = [((s['start']['x'], s['start']['y']), (s['end']['x'], s['end']['y'])) for s in vectors]
bounds = g._bounds(case.roi_box, width, height)
print(json.dumps({'size': [width, height], 'bounds': bounds, 'snap': g._max_shift(bounds),
                  'vector_count': len(vectors), 'sha256': sha256(Path(case.document).read_bytes()).hexdigest()}))
for rec in b.load_captures(case.id):
    if rec['outcome'] != 'parsed' or rec['roi_too_tight']:
        print(json.dumps({'at': rec['captured_at'], 'outcome': rec['outcome']}))
        continue
    result = g.refine_outline_polygons(png, case.roi_box, rec['crop'], rec['polygons'], vectors,
                                      cleanup='shapely', boundary_policy=case.boundary_policy)
    print(json.dumps({'at': rec['captured_at'], 'raw': b._model_rings(rec), 'warnings': result['warnings']}))
    for proposal in result['proposals']:
        points = [(p['x'], p['y']) for p in proposal['points']]
        for index, (a, z) in enumerate(zip(points, points[1:] + points[:1])):
            if min(a[1], z[1]) < 2580 or g._distance(a, z) < 100:
                continue
            candidates = g._vector_candidates(a, z, segments, g._max_shift(bounds))
            candidates.sort(key=lambda c: -c['score'])
            print(json.dumps({'bottom_edge': [a, z], 'evidence': proposal['edges'][index],
                              'candidates': [{k: c[k] for k in ('normal', 'offset', 'displacement', 'support', 'score')} for c in candidates]}))
print('Long nearby horizontal vectors:')
for a, z in segments:
    if 2580 < a[1] < 2700 and abs(a[1] - z[1]) < .1 and g._distance(a, z) > 300:
        print(json.dumps([a, z]))
