"""Offline comparison against the v7 snapshot; never calls a model."""
import json
import sys
import types
from pathlib import Path
from time import perf_counter

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import outline_geometry as g
from backend.roi_reference import outline_benchmark as b

baseline = types.ModuleType('backend.app.perimeter_baseline')
baseline.__package__ = 'backend.app'
sys.modules[baseline.__name__] = baseline
exec(Path('tmp/outline_geometry_v7_snapshot.py').read_text(), baseline.__dict__)
rows = []
for case in b.load_outline_manifest().cases:
    png = b.page_png(case)
    width, height = g._page_size(png)
    vectors = b.roi_vectors(b.page_vectors(case), width, height, case.roi_box)
    for record in b.load_captures(case.id):
        if record['outcome'] != 'parsed' or record['roi_too_tight']:
            continue
        args = (png, case.roi_box, record['crop'], record['polygons'], vectors)
        old = baseline.refine_outline_polygons(*args, cleanup='shapely', boundary_policy=case.boundary_policy)
        started = perf_counter()
        new = g.refine_outline_polygons(*args, cleanup='shapely', boundary_policy=case.boundary_policy)
        elapsed = perf_counter() - started
        geometry_changed = [p['points'] for p in old['proposals']] != [p['points'] for p in new['proposals']]
        row = {'case': case.id, 'capture': record['captured_at'], 'geometry_changed': geometry_changed,
               'duration_ms': round(elapsed*1000), 'before': old, 'after': new}
        rows.append(row)
        print(json.dumps({k:v for k,v in row.items() if k not in ('before','after')} | {'warnings': new['warnings']}))
        if geometry_changed:
            print('points', json.dumps([p['points'] for p in new['proposals']]))
Path('tmp/perimeter-alignment-replay.json').write_text(json.dumps(rows, indent=2))
expected_changes = {
    '2026-11-02T00:49:26.731715+00:00',
    '2026-11-02T00:51:03.533810+00:00',
    '2026-11-02T00:51:35.476689+00:00',
}
assert len(rows) == 22
assert {r['capture'] for r in rows if r['geometry_changed']} == expected_changes
for row in rows:
    assert [p['proposed_points'] for p in row['before']['proposals']] == [p['proposed_points'] for p in row['after']['proposals']]
    if row['geometry_changed']:
        assert row['case'] == '251004-terrace'
        assert 'boundary_alignment_corrected' in row['after']['warnings']
        points = row['after']['proposals'][0]['points']
        top = sorted((p['x'], p['y']) for p in points if abs(p['y'] - 1241.84) < 1e-6)
        assert len(top) == 2
        assert abs(top[0][0] - 1371.12) < 1e-6 and abs(top[1][0] - 1656) < 1e-6
print('total',len(rows),'geometry_changed',sum(r['geometry_changed'] for r in rows))
