"""Offline v6 comparison and a constructed left-step case on the supplied PDF."""
import json
from hashlib import sha256
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
baseline_ref = 'db6387ff74621c80baa75618d8b6277daa017401'
exec(subprocess.check_output(['git', 'show', f'{baseline_ref}:backend/app/outline_geometry.py'], text=True), baseline.__dict__)
report = {'baseline_ref': baseline_ref, 'algorithm': current.ALGORITHM_VERSION,
          'captures': [], 'constructed_left_step': {}}
for case in benchmark.load_outline_manifest().cases:
    assert sha256((benchmark.REPOSITORY / case.document).read_bytes()).hexdigest() == case.source_sha256
    png = benchmark.page_png(case)
    width, height = current._page_size(png)
    vectors = benchmark.roi_vectors(benchmark.page_vectors(case), width, height, case.roi_box)
    for record in benchmark.load_captures(case.id):
        if record['outcome'] != 'parsed' or record['roi_too_tight']:
            continue
        args = (png, case.roi_box, record['crop'], record['polygons'], vectors)
        old = baseline.refine_outline_polygons(*args, cleanup='shapely', boundary_policy=case.boundary_policy)
        new = current.refine_outline_polygons(*args, cleanup='shapely', boundary_policy=case.boundary_policy)
        row = {'case': case.id, 'capture': record['captured_at'], 'changed': old != new}
        if old != new:
            row.update(before=old, after=new)
        report['captures'].append(row)
    if case.id != '251004-terrace':
        continue
    # Model-like switch at the terrace/green-roof junction, NOT a captured reply.
    ring = [(1371.12, 1241.84), (1656., 1241.84), (1656., 2448.08), (385.92, 2448.08),
            (385.92, 2154.8), (395.76, 2154.8), (395.76, 1719.44), (1371.12, 1719.44)]
    crop = current.prepare_outline_crop(png, case.roi_box).crop
    polygons = [[{'x': (x-crop['x'])*1000/crop['width'], 'y': (y-crop['y'])*1000/crop['height']} for x,y in ring]]
    args = (png, case.roi_box, crop, polygons, vectors)
    report['constructed_left_step'] = {'ring': ring, 'before': baseline.refine_outline_polygons(*args, cleanup='shapely'),
                                      'after': current.refine_outline_polygons(*args, cleanup='shapely')}
Path('tmp/outline-side-fit-verification.json').write_text(json.dumps(report, indent=2))
print('capture_count', len(report['captures']), 'changed', sum(row['changed'] for row in report['captures']))
left = report['constructed_left_step']
for stage in ('before', 'after'):
    proposal = left[stage]['proposals'][0]
    print(stage, json.dumps({'vertices': len(proposal['points']),
                            'left': [p for p in proposal['points'] if p['x'] < 450],
                            'warnings': proposal['warnings']}))
assert len(left['before']['proposals'][0]['points']) == 8
assert len(left['after']['proposals'][0]['points']) == 6
assert 'boundary_steps_straightened' in left['after']['warnings']
assert all(not row['changed'] for row in report['captures'])
