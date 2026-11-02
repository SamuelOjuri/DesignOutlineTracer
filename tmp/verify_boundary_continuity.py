"""Offline comparison with the committed v2 fitter on every saved model reply."""
import json
import subprocess
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import outline_geometry as current
from backend.roi_reference import outline_benchmark as benchmark

baseline = types.ModuleType('backend.app.outline_geometry_baseline')
baseline.__package__ = 'backend.app'
sys.modules[baseline.__name__] = baseline
exec(subprocess.check_output(['git', 'show', 'HEAD:backend/app/outline_geometry.py'], text=True), baseline.__dict__)
changed = []
for case in benchmark.load_outline_manifest().cases:
    png = benchmark.page_png(case)
    width, height = current._page_size(png)
    vectors = benchmark.roi_vectors(benchmark.page_vectors(case), width, height, case.roi_box)
    for record in benchmark.load_captures(case.id):
        if record['outcome'] != 'parsed' or record['roi_too_tight']:
            continue
        args = (png, case.roi_box, record['crop'], record['polygons'], vectors)
        old = baseline.refine_outline_polygons(*args, cleanup='shapely')
        new = current.refine_outline_polygons(*args, cleanup='shapely', boundary_policy=case.boundary_policy)
        if old != new:
            row = {'case': case.id, 'capture': record['captured_at'], 'before': old, 'after': new}
            changed.append(row)
            print(json.dumps({'case': case.id, 'capture': record['captured_at'],
                              'vertices': [[len(p['points']) for p in r['proposals']] for r in (old, new)],
                              'warnings': new['warnings'],
                              'after': [p['points'] for p in new['proposals']]}))
Path('tmp/continuity-replay.json').write_text(json.dumps(changed, indent=2))

def old_variant(context, record):
    result = baseline.refine_outline_polygons(context['png'], context['case'].roi_box, record['crop'],
                                             record['polygons'], context['vectors'], cleanup='shapely')
    return ([[ (p['x'], p['y']) for p in proposal['points']] for proposal in result['proposals']] or None,
            None if result['proposals'] else result['status'])

benchmark.VARIANTS['v2+shapely'] = old_variant
report = benchmark.score(['v2+shapely', 'production+shapely'])
Path('tmp/continuity-benchmark.json').write_text(json.dumps(report, indent=2))
print(benchmark.markdown(report))
