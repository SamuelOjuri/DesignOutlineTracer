import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.app import outline_geometry as g
from backend.roi_reference.outline_benchmark import load_outline_manifest, load_captures, page_png, page_vectors, roi_vectors, _model_rings

case = load_outline_manifest().cases[0]
png = page_png(case)
width, height = g._page_size(png)
vectors = roi_vectors(page_vectors(case), width, height, case.roi_box)
segments = [((s['start']['x'], s['start']['y']), (s['end']['x'], s['end']['y'])) for s in vectors]
records = load_captures(case.id)
out = []
for record in records:
    if record['outcome'] != 'parsed':
        continue
    result = g.refine_outline_polygons(png, case.roi_box, record['crop'], record['polygons'], vectors, cleanup='shapely')
    out.append({'at': record['captured_at'], 'raw': _model_rings(record), 'result': result})
    print(json.dumps({'at': record['captured_at'], 'raw': [[list(map(lambda v: round(v, 2), p)) for p in r] for r in _model_rings(record)],
                      'fitted': [[{k: round(v, 2) for k, v in p.items()} for p in item['points']] for item in result['proposals']],
                      'warnings': result['warnings']}))
Path('tmp/right-boundary-baseline.json').write_text(json.dumps(out, indent=2))
print('Right-side vectors:')
for a,b in segments:
    if min(a[0],b[0]) > 1630 and max(a[0],b[0]) < 1675 and g._distance(a,b) > 100:
        print(a,b)

from backend.roi_reference.outline_side_aware import side_aware_refine
from backend.roi_reference.outline_metrics import score_outline
from PIL import Image, ImageDraw, ImageFont
from io import BytesIO

record = next(r for r in records if r.get('polygons') and len(r['polygons'][0]) == 8)
baseline = g.refine_outline_polygons(png, case.roi_box, record['crop'], record['polygons'], vectors, cleanup='shapely')
side = side_aware_refine(png, case.roi_box, record['crop'], record['polygons'], vectors)
original_shift = g._max_shift
try:
    g._max_shift = lambda bounds: 24.
    wider = g.refine_outline_polygons(png, case.roi_box, record['crop'], record['polygons'], vectors, cleanup='shapely')
finally:
    g._max_shift = original_shift
for name, result in [('current', baseline), ('opencv_side', side), ('radius_24', wider)]:
    print(name, json.dumps(result['proposals'][0]))

ring = [(p['x'], p['y']) for p in baseline['proposals'][0]['points']]
# A diagnostic, hand-selected candidate, NOT a general repair algorithm:
# merge just the two right-side runs onto the full-length inner roof-edge vector.
candidate = [ring[0], (1656., ring[1][1]), (1656., ring[4][1]), *ring[5:]]
report = {'case': case.id, 'capture': record['captured_at'], 'current': baseline, 'opencv_side': side,
          'radius_24': wider, 'illustrative_candidate': candidate,
          'current_score': score_outline([ring], case.reference.polygons).as_dict(),
          'candidate_score': score_outline([candidate], case.reference.polygons).as_dict()}
Path('tmp/right-boundary-comparison.json').write_text(json.dumps(report, indent=2))
print('candidate_valid', g._valid_ring(candidate), 'area_change_fraction', abs(g._area(candidate)) / abs(g._area(ring)) - 1)
print('scores', json.dumps({k: report[k] for k in ['current_score', 'candidate_score']}))

# A source-based diagnostic figure showing where the model switches drawn faces.
page = Image.open(BytesIO(png)).convert('RGB')
sheet = Image.new('RGB', (1500, 1080), 'white')
draw = ImageDraw.Draw(sheet)
font = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 24)
small = ImageFont.truetype('C:/Windows/Fonts/arial.ttf', 19)
draw.text((24, 14), '251004: the proposed right edge switches between two different drawn faces', fill='#172b4d', font=font)
draw.text((24, 49), 'Red: replayed model/fitted boundary    Blue: continuous inner roof-edge vector (x = 1656)', fill='#172b4d', font=small)

def panel(bounds, dest, target, title):
    left, top, right, bottom = bounds
    scale = min(target[0] / (right-left), target[1] / (bottom-top))
    crop = page.crop(bounds).resize((round((right-left)*scale), round((bottom-top)*scale)))
    sheet.paste(crop, dest)
    transform = lambda p: (dest[0]+(p[0]-left)*scale, dest[1]+(p[1]-top)*scale)
    # Draw only the source boundary spans relevant to this panel, clipped in a local layer.
    layer = Image.new('RGBA', crop.size, (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    local = lambda p: ((p[0]-left)*scale, (p[1]-top)*scale)
    ld.line([local(p) for p in ring+[ring[0]]], fill='#dd3030', width=3)
    ld.line([local((1656, 1241.84)), local((1656, 2448.08))], fill='#0069d9', width=3)
    sheet.paste(layer, dest, layer)
    draw.text((dest[0], dest[1]-30), title, fill='#172b4d', font=small)

panel((340, 1180, 1710, 2500), (24, 116), (955, 920), 'Whole roof: both long right-side runs should follow one roof boundary')
panel((1570, 2060, 1695, 2240), (1030, 160), (410, 600), 'Zoom at the false step')
draw.text((1030, 780), 'Model jump: x 1637.36 -> 1660.19', fill='#b52020', font=small)
draw.text((1030, 813), f'Step width: {ring[3][0] - ring[2][0]:.2f} source pixels', fill='#172b4d', font=small)
draw.text((1030, 846), 'Upper-edge correction: 18.64 px', fill='#172b4d', font=small)
draw.text((1030, 879), 'Current snapping limit: 12 px', fill='#172b4d', font=small)
draw.text((24, 1044), 'Diagnostic replay from a saved capture; reference convention is provisional and awaits domain review.', fill='#536273', font=small)
Path('tmp/pdfs').mkdir(exist_ok=True)
sheet.save('tmp/pdfs/251004-right-boundary-diagnosis.png')
