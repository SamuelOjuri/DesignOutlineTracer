"""Offline corner regression replay and comparison with the supplied CAD PDF."""
from io import BytesIO
import json
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import fitz
from PIL import Image, ImageDraw
from backend.app import outline_geometry as g
from backend.app.errors import RoiError
from backend.roi_reference import outline_benchmark as b
from backend.roi_reference.outline_metrics import score_outline


def old_corner_steps(points, tolerance, bounds):
    """Previous one/two-leg corner rule, for comparison only."""
    left, top, right, bottom = bounds
    result = list(points)
    changed = True
    while changed:
        changed = False
        size = len(result)
        for start in range(size):
            for count in (1, 2):
                if size - count < 3:
                    continue
                run = [result[(start + k) % size] for k in range(count + 1)]
                before, after = result[start - 1], result[(start + count + 1) % size]
                if (any(g._distance(a, z) >= tolerance for a, z in zip(run, run[1:]))
                        or g._distance(before, run[0]) < 2*tolerance
                        or g._distance(run[-1], after) < 2*tolerance):
                    continue
                corner = g._meet(before, run[0], run[-1], after)
                if (corner is None or any(g._distance(corner, point) > 1.5*tolerance for point in run)
                        or not (left <= corner[0] <= right and top <= corner[1] <= bottom)):
                    continue
                removed = {(start + k) % size for k in range(count + 1)}
                candidate = [corner if index == start else point for index, point in enumerate(result)
                             if index == start or index not in removed]
                if g._valid_ring(candidate):
                    result, changed = candidate, True
                    break
            if changed:
                break
    return result


def rings(result):
    return [[(p['x'], p['y']) for p in proposal['points']] for proposal in result['proposals']]


summary = {'algorithm': g.ALGORITHM_VERSION, 'cases': 0, 'parsed': 0, 'unchanged_geometry': 0,
           'changed': [], 'failures': [], 'tp17221': []}
example = None
for case in b.load_outline_manifest().cases:
    summary['cases'] += 1
    png = b.page_png(case)
    width, height = g._page_size(png)
    vectors = b.roi_vectors(b.page_vectors(case), width, height, case.roi_box)
    for record in b.load_captures(case.id):
        if record['outcome'] != 'parsed' or record['roi_too_tight']:
            continue
        summary['parsed'] += 1
        def replay():
            return g.refine_outline_polygons(png, case.roi_box, record['crop'], record['polygons'], vectors,
                                            cleanup='shapely', boundary_policy=case.boundary_policy)
        try:
            with patch.object(g, '_straighten_traced_sides', lambda ring, *_: ring), \
                    patch.object(g, '_collapse_corner_steps', old_corner_steps):
                before = replay()
            after = replay()
        except RoiError as error:
            summary['failures'].append({'case': case.id, 'at': record['captured_at'], 'error': error.code})
            continue
        if not after['proposals'] or not g._disjoint(rings(after)):
            summary['failures'].append({'case': case.id, 'at': record['captured_at'], 'error': after['status']})
            continue
        if rings(before) == rings(after):
            summary['unchanged_geometry'] += 1
        else:
            scores = [score_outline(rings(result), case.reference.polygons, step=4) for result in (before, after)]
            summary['changed'].append({'case': case.id, 'at': record['captured_at'],
                'before_vertices': sum(map(len, rings(before))), 'after_vertices': sum(map(len, rings(after))),
                'before_iou': scores[0].iou, 'after_iou': scores[1].iou,
                'before_mean_distance': scores[0].mean_distance, 'after_mean_distance': scores[1].mean_distance})
            if case.id != 'tp17221-roof':
                print(json.dumps({'case': case.id, 'original': after['proposals'][0]['proposed_points'],
                                  'before': rings(before), 'after': rings(after), 'warnings': after['warnings']}))
        if case.id == 'tp17221-roof':
            ring = rings(after)[0]
            bottom = max(y for _, y in ring)
            summary['tp17221'].append({'at': record['captured_at'], 'vertices': len(ring),
                'bottom_y': bottom, 'warnings': after['warnings']})
            # The reference corner must be a single angular vertex. Independent
            # long-side bends elsewhere are not forced into a 12-point template.
            assert sum(g._distance(point, (1490, 2085)) < 50 for point in ring) == 1
            assert abs(bottom - 2618.96) < .01
            assert not {'local_fitting_limited', 'corner_steps_straightened', 'fitting_rejected'} & set(after['warnings'])
            if '00:50:06' in record['captured_at']:
                assert len(ring) == 12
                example = png, before, after

Path('tmp/cad-corner-verification.json').write_text(json.dumps(summary, indent=2))
print(json.dumps(summary, indent=2))
assert not summary['failures']

if example:
    png, before, after = example
    # Each panel is an enlarged local crop, not a geometric registration of the
    # independently laid-out CAD export and source plan.
    reference = Path('C:/Users/SamuelOjuri/OneDrive - Tapered Plus/Documents/Samsdocs/Roof Plan Docs/Example 2 - TP17221/TP17221_25.01_outline.pdf')
    document = fitz.open(reference)
    pixmap = document[0].get_pixmap(matrix=fitz.Matrix(5, 5), clip=fitz.Rect(673, 745, 773, 845), alpha=False)
    ref = Image.frombytes('RGB', (pixmap.width, pixmap.height), pixmap.samples).resize((500, 500))
    figure = Image.new('RGB', (1500, 550), 'white')
    figure.paste(ref, (0, 50))
    draw = ImageDraw.Draw(figure)
    draw.text((12, 12), 'Provided CAD reference: one angular vertex', fill='black')
    raster = Image.open(BytesIO(png)).convert('RGB')
    for index, (result, label) in enumerate(((before, 'Previous corner handling'), (after, 'New: adjoining straight sides meet')), 1):
        left, top, side, scale = 1390, 1985, 200, 2.5
        panel = raster.crop((left, top, left+side, top+side)).resize((500, 500))
        ink = ImageDraw.Draw(panel)
        for ring in rings(result):
            ink.line([((x-left)*scale, (y-top)*scale) for x, y in ring + ring[:1]], fill='#2563eb', width=3)
        figure.paste(panel, (500*index, 50))
        draw.text((500*index+12, 12), label, fill='black')
    figure.save('tmp/pdfs/tp17221-corner-validation.png')
