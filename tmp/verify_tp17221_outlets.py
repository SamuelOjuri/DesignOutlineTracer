"""Offline source-symbol measurement; no provider calls or application state changes."""
from io import BytesIO
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pymupdf
from PIL import Image, ImageDraw
from backend.app.outlet_models import OutletAnnotation, OutletScope
from backend.app.outlet_symbols import refine_outlet_symbols

path = Path(r'C:\Users\SamuelOjuri\OneDrive - Tapered Plus\Documents\Samsdocs\Roof Plan Docs\Example 2 - TP17221\TP17221_25.01_input.pdf')
with pymupdf.open(path) as doc:
    png = doc[0].get_pixmap(matrix=pymupdf.Matrix(2, 2)).tobytes('png')
image = Image.open(BytesIO(png)).convert('RGB')
manifest = json.loads(Path('docs/roi-evaluation/outline-manifest.json').read_text())
case = next(case for case in manifest['cases'] if case['id'] == 'tp17221-roof')
scope = OutletScope(roi_id='roof', outline_id='outline', polygons=[{'outer': [dict(x=x, y=y) for x, y in ring]} for ring in case['reference']['polygons']])
# PDF points measured from the cyan inlet strokes; deliberately seed each anchor
# on (or slightly outside) the corresponding inner parapet, as in the report.
boxes = [(405.84, 1086.04, 420, 1114.36), (554.76, 1298.4, 583.08, 1312.56),
         (868.8, 1298.4, 897.12, 1312.56), (1024.44, 1164.04, 1052.76, 1178.2),
         (1594.68, 1164.04, 1623, 1178.2)]
anchors = [(407, 1100.2), (568.92, 1310), (882.96, 1310), (1038.6, 1175.8), (1608.84, 1175.8)]
items = []
for index, ((left, top, right, bottom), (x, y)) in enumerate(zip(boxes, anchors), 1):
    box = [top * 2 / image.height * 1000, left * 2 / image.width * 1000,
           bottom * 2 / image.height * 1000, right * 2 / image.width * 1000]
    items.append(OutletAnnotation(id=f'rwp-{index}', page_id='page', label=f'rwp.{index}', subtype='parapet_outlet',
        box_2d=box, proposed_box_2d=box, anchor=dict(x=x*2, y=y*2), proposed_anchor=dict(x=x*2, y=y*2),
        roi_id='roof', outline_id='outline', evidence='Roof-side cyan inlet box paired with an external RWP.'))
refine_outlet_symbols(png, items, scope)
result = [{'label': item.label, 'before': item.proposed_anchor.model_dump(), 'after': item.anchor.model_dump(),
           'refined': item.anchor != item.proposed_anchor} for item in items]
Path('tmp/tp17221-outlet-verification.json').write_text(json.dumps(result, indent=2))
print(json.dumps(result, indent=2))
figure = Image.new('RGB', (1000, 240), 'white')
for index, item in enumerate(items):
    x, y = item.proposed_anchor.x, item.proposed_anchor.y
    left, top = int(x-48), int(y-48)
    panel = image.crop((left, top, left+96, top+96)).resize((192, 192))
    draw = ImageDraw.Draw(panel)
    for point, colour in ((item.proposed_anchor, '#dc2626'), (item.anchor, '#0077cc')):
        cx, cy = (point.x-left)*2, (point.y-top)*2
        draw.ellipse((cx-8, cy-8, cx+8, cy+8), outline=colour, width=2)
    figure.paste(panel, (index*200, 25))
    ImageDraw.Draw(figure).text((index*200+5, 5), item.label, fill='black')
ImageDraw.Draw(figure).text((5, 220), 'Red: simulated perimeter anchor. Blue: fitted source inlet centre.', fill='black')
figure.save('tmp/pdfs/tp17221-outlet-fitted.png')
assert all(row['refined'] for row in result), 'Some source boxes were not identified'
